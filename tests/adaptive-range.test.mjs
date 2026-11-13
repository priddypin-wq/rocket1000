import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rangeConditions,
  rangeProposalAllowed,
} from "../server/range-conditions.mjs";
import { selectedStrategyProfile } from "../server/strategy.mjs";
import { validateAssessment } from "../server/ai-analysis.mjs";

// Closed-bar protocol fixtures only. No real model, terminal or broker calls.
function fixture(side = "BUY") {
  const bars = Array.from({ length: 42 }, (_, i) => {
    const low = i % 10 === 0 ? 100 : i % 10 === 5 ? 108 : 103;
    return {
      time: i * 300 + 300,
      open: low + 0.5,
      close: low + 1,
      high: low + 2,
      low,
    };
  });
  const confirmation = [
    { time: 13000, open: 100.4, close: 100.5, high: 100.6, low: 100.05 },
    { time: 13060, open: 100.5, close: 100.8, high: 101, low: 100.4 },
  ];
  const s = {
    symbol: "EURUSDm",
    timestamp: 14000000,
    bid: 100.75,
    ask: 100.85,
    timeframes: { M5: { bars }, M1: { bars: confirmation } },
  };
  const p = {
    ready: true,
    regime: "range",
    effectiveRiskPct: 0.125,
    minRewardRisk: 1.5,
    allowedStrategies: ["wait"],
    frames: { M5: { atr14: 2 }, M15: { trend: { direction: "range" } } },
  };
  const e = {
    sessionOpen: true,
    tradeAllowed: true,
    symbolTradeMode: 4,
    tradeExecutionMode: 2,
    orderMode: 49,
    costsVerified: true,
    commissionPerLot: 0,
    tickSize: 0.01,
    tickValue: 1,
    point: 0.01,
  };
  if (side === "SELL") {
    for (const frame of Object.values(s.timeframes))
      for (const b of frame.bars) {
        const old = { ...b };
        b.open = 210 - old.open;
        b.close = 210 - old.close;
        b.high = 210 - old.low;
        b.low = 210 - old.high;
      }
    [s.bid, s.ask] = [210 - s.ask, 210 - s.bid];
  }
  return { s, p, e };
}
for (const side of ["BUY", "SELL"])
  test(`${side}: range eligibility uses prior repeated boundaries and a later completed confirmation`, () => {
    const { s, p, e } = fixture(side),
      r = rangeConditions(s, p, e, 0.1);
    assert.equal(r.eligible, true);
    assert.equal(r.side, side);
    assert.equal(r.support, 100);
    assert.equal(r.resistance, 110);
    const profile = selectedStrategyProfile(s, {}, p, e);
    assert.ok(profile.allowedStrategies.includes("range"));
    const stop = side === "BUY" ? 99 : 111,
      target = side === "BUY" ? 108 : 102;
    assert.equal(rangeProposalAllowed(profile, side, stop, target), true);
    assert.equal(
      rangeProposalAllowed(
        profile,
        side,
        side === "BUY" ? 100.1 : 109.9,
        target,
      ),
      false,
    );
    assert.equal(
      rangeProposalAllowed(profile, side, stop, side === "BUY" ? 111 : 99),
      false,
    );
    const assessment = {
      decision: side,
      confidence: 0.9,
      strategy: "range",
      timeframe: "M1",
      entryPrice: side === "BUY" ? s.ask : s.bid,
      stopLoss: stop,
      takeProfit: target,
      reasoning: "Fixture confirmed range rejection",
      risks: [],
    };
    assert.equal(validateAssessment(assessment, s, profile).decision, side);
    assert.throws(() =>
      validateAssessment(
        { ...assessment, takeProfit: side === "BUY" ? 111 : 99 },
        s,
        profile,
      ),
    );
  });
for (const [name, change] of [
  ["trending market", (f) => (f.p.regime = "trend")],
  [
    "directional higher timeframe",
    (f) => (f.p.frames.M15.trend.direction = "up"),
  ],
  ["no available risk", (f) => (f.p.effectiveRiskPct = 0)],
  ["extreme volatility", (f) => (f.p.frames.M5.atr14 = 7)],
  ["broker session closed", (f) => (f.e.sessionOpen = false)],
  ["terminal execution disabled", (f) => (f.e.tradeAllowed = false)],
  ["unknown order permissions", (f) => delete f.e.orderMode],
  ["invalid candle geometry", (f) => (f.s.timeframes.M5.bars[10].high = 0)],
  ["unordered confirmation", (f) => (f.s.timeframes.M1.bars[1].time = 1)],
  ["unconfirmed candle", (f) => f.s.timeframes.M1.bars.pop()],
  [
    "late entry",
    (f) => {
      f.s.bid = 106;
      f.s.ask = 106.1;
    },
  ],
  [
    "breakout beyond the range",
    (f) => {
      f.s.bid = 111;
      f.s.ask = 111.1;
    },
  ],
])
  test(`range skips ${name}`, () => {
    const f = fixture();
    change(f);
    assert.equal(rangeConditions(f.s, f.p, f.e, 0.1).eligible, false);
  });
test("range cost and data failures remain WAIT eligibility, never an invented setup", () => {
  const { s, p, e } = fixture();
  for (const costs of [null, undefined, NaN, Infinity, -1, 2])
    assert.equal(rangeConditions(s, p, e, costs).eligible, false);
  assert.equal(
    selectedStrategyProfile(s, {}, p, { ...e, costsVerified: false }).range
      .eligible,
    false,
  );
  assert.ok(
    !selectedStrategyProfile(
      s,
      { strategy: "scalping" },
      p,
      e,
    ).allowedStrategies.includes("range"),
  );
  assert.equal(rangeProposalAllowed({}, "BUY", 99, 108), false);
});
