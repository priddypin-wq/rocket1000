import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIMEFRAMES,
  validateSnapshot,
  requireMultiTimeframe,
  decisionBar,
  technicals,
  adaptiveProfile,
} from "../server/market.mjs";

// Deterministic numerical fixtures only. No provider or broker is contacted.
const NOW = 1800000000000;
function candles(
  seconds,
  closes = Array.from({ length: 220 }, (_, i) => 80 + i * (119 / 219)),
) {
  const boundary = Math.floor(NOW / (seconds * 1000)) * seconds;
  return closes.map((close, i) => ({
    time: boundary - (closes.length - i) * seconds,
    open: close - 0.25,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 + i,
  }));
}
function snapshot() {
  const timeframes = Object.fromEntries(
    Object.entries(TIMEFRAMES).map(([name, seconds]) => [
      name,
      { bars: candles(seconds) },
    ]),
  );
  return {
    symbol: "XAUUSD",
    timeframe: "M5",
    timestamp: NOW,
    brokerTimestamp: NOW,
    quoteTimestamp: NOW,
    bid: 199,
    ask: 199.1,
    balance: 1000,
    equity: 1000,
    currency: "USD",
    positions: [],
    bars: structuredClone(timeframes.M5.bars),
    timeframes,
  };
}
function closeTo(actual, expected, tolerance = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} differs from ${expected}`,
  );
}

test("all four bounded terminal frames are sanitized while legacy M5 stays compatible", () => {
  const input = snapshot();
  input.timeframes.M1.bars[0].credential = "discard-this";
  const clean = validateSnapshot(input, NOW);
  assert.equal(clean.timeframes.M1.bars[0].credential, undefined);
  assert.deepEqual(Object.keys(clean.timeframes), ["M1", "M5", "M15", "H1"]);
  assert.equal(requireMultiTimeframe(clean), clean);
  assert.equal(decisionBar(clean), clean.timeframes.M1.bars.at(-1).time);
  delete input.timeframes;
  const legacy = validateSnapshot(input, NOW);
  assert.equal(legacy.timeframes, undefined);
  assert.equal(decisionBar(legacy), legacy.bars.at(-1).time);
  assert.throws(
    () => requireMultiTimeframe(legacy),
    (e) => e.status === 409 && e.code === "MULTI_TIMEFRAME_REQUIRED",
  );
});

test("invalid, unaligned, stale, current and conflicting timeframe candles are rejected", () => {
  const patches = [
    (s) => {
      s.timeframes.M1.bars = s.timeframes.M1.bars.slice(0, 49);
    },
    (s) => {
      s.timeframes.M1.bars.push(...s.timeframes.M1.bars.slice(0, 21));
    },
    (s) => {
      s.timeframes.M15.bars.reverse();
    },
    (s) => {
      s.timeframes.H1.bars[0].time++;
    },
    (s) => {
      s.timeframes.M1.bars.at(-1).high = 1;
    },
    (s) => {
      s.timeframes.M15.bars[0].volume = -1;
    },
    (s) => {
      s.timeframes.H1.bars[0].open = Infinity;
    },
    (s) => {
      s.timeframes.M5.bars.at(-1).close -= 0.1;
    },
    (s) => {
      s.timeframes.D1 = { bars: candles(86400) };
    },
    (s) => {
      s.timeframes.M1.bars = s.timeframes.M1.bars.map((b) => ({
        ...b,
        time: b.time - 180,
      }));
    },
    (s) => {
      s.timeframes.M1.bars.at(-1).time += 60;
    },
  ];
  for (const patch of patches) {
    const s = snapshot();
    patch(s);
    assert.throws(
      () => validateSnapshot(s, NOW),
      (e) => e.code === "MARKET_DATA_INVALID",
    );
  }
});

test("each frame accepts at most two intervals of closed-bar delay and M5 retains 600 seconds", () => {
  for (const [name, seconds] of Object.entries(TIMEFRAMES)) {
    const s = snapshot();
    // Move the verified broker clock to an exact bar boundary for this frame.
    s.brokerTimestamp = Math.floor(NOW / (seconds * 1000)) * seconds * 1000;
    for (const b of s.timeframes[name].bars) b.time -= seconds * 2;
    if (name === "M5") s.bars = structuredClone(s.timeframes.M5.bars);
    assert.doesNotThrow(() => requireMultiTimeframe(s));
    for (const b of s.timeframes[name].bars) b.time -= seconds;
    assert.throws(
      () => requireMultiTimeframe(s),
      (e) => e.status === 409 && e.message.includes(name),
    );
  }
});

test("flat prices yield neutral RSI and MACD with finite Wilder ATR and support/resistance", () => {
  const t = technicals({
    bars: candles(60, Array(100).fill(100)),
    bid: 100,
    ask: 100.1,
  });
  assert.equal(t.rsi14, 50);
  assert.deepEqual(t.macd, {
    line: 0,
    signal: 0,
    histogram: 0,
    signalMethod: "EMA9",
  });
  closeTo(t.ema9, 100);
  closeTo(t.ema21, 100);
  closeTo(t.ema50, 100);
  closeTo(t.atr14, 2);
  assert.equal(t.support, 99);
  assert.equal(t.resistance, 101);
  assert.equal(t.trend.direction, "range");
  closeTo(t.volatilityRatio, 1);
});

test("Wilder RSI matches the published 14-change numerical seed and remains unchanged by flat closes", () => {
  const sample = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89,
    46.03, 45.61, 46.28, 46.28,
  ];
  const closes = [...sample, ...Array(35).fill(46.28)];
  const t = technicals({ bars: candles(60, closes), bid: 46.28, ask: 46.29 });
  closeTo(t.rsi14, 70.46413502109705);
  const falling = technicals({
    bars: candles(
      60,
      Array.from({ length: 50 }, (_, i) => 100 - i),
    ),
    bid: 51,
    ask: 51.1,
  });
  assert.equal(falling.rsi14, 0);
  assert.equal(falling.trend.direction, "down");
});

test("EMA and MACD match independent closed-form ramp values and EMA9 signal weighting", () => {
  const t = technicals({
    bars: candles(
      60,
      Array.from({ length: 100 }, (_, i) => 100 + i),
    ),
    bid: 200,
    ask: 200.1,
  });
  const expectedEma = (period) =>
    199 - ((period - 1) / 2) * (1 - ((period - 1) / (period + 1)) ** 99);
  closeTo(t.ema9, expectedEma(9));
  closeTo(t.ema21, expectedEma(21));
  closeTo(t.ema50, expectedEma(50));
  const macdAt = (i) => 7 - 12.5 * (25 / 27) ** i + 5.5 * (11 / 13) ** i;
  let expectedSignal = 0;
  for (let i = 1; i <= 99; i++)
    expectedSignal += 0.2 * macdAt(i) * 0.8 ** (99 - i);
  closeTo(t.macd.line, macdAt(99));
  closeTo(t.macd.signal, expectedSignal);
  closeTo(t.macd.histogram, macdAt(99) - expectedSignal);
  assert.equal(t.trend.direction, "up");
});

test("ATR is Wilder-smoothed, includes price gaps and compares with prior ATR median", () => {
  const bars = candles(60, Array(50).fill(100));
  bars.at(-2).high = 108;
  bars.at(-2).low = 92;
  const t = technicals({ bars, bid: 100, ask: 100.1 });
  closeTo(t.atr14, 41 / 14);
  closeTo(t.volatilityRatio, 41 / 28);
  assert.notEqual(
    t.atr14,
    3,
    "must not use the simple trailing 14-bar average",
  );
  bars.at(-1).open = 110;
  bars.at(-1).close = 110;
  bars.at(-1).high = 111;
  bars.at(-1).low = 109;
  closeTo(technicals({ bars, bid: 110, ask: 110.1 }).atr14, 50 / 14);
});

test("support and resistance exclude the newest bar and use all prior twenty bars", () => {
  const bars = candles(60, Array(100).fill(100));
  bars.at(-21).high = 112;
  bars.at(-21).low = 88;
  bars.at(-22).high = 120;
  bars.at(-22).low = 80;
  bars.at(-1).high = 150;
  bars.at(-1).low = 50;
  const t = technicals({ bars, bid: 100, ask: 100.1 });
  assert.equal(t.resistance, 112);
  assert.equal(t.support, 88);
  assert.equal(t.priorHigh, 101, "legacy ten-bar sweep levels stay compatible");
});

test("missing or stale multi-timeframe data returns WAIT permissions with no risk and no invented frames", () => {
  const missing = snapshot();
  delete missing.timeframes.M15;
  const p = adaptiveProfile(missing, { tradingMode: "aggressive" });
  assert.equal(p.ready, false);
  assert.equal(p.effectiveRiskPct, 0);
  assert.deepEqual(p.allowedStrategies, ["wait"]);
  assert.deepEqual(p.frames, {});
  assert.match(p.reason, /M15/);
  const stale = snapshot();
  stale.timeframes.M1.bars = stale.timeframes.M1.bars.map((b) => ({
    ...b,
    time: b.time - 180,
  }));
  assert.match(adaptiveProfile(stale).reason, /stale/);
});

test("balanced and aggressive profiles cap configured risk and confidence while allowing affordable confirmed scalps", () => {
  const s = snapshot();
  const balanced = adaptiveProfile(s, {
    tradingMode: "balanced",
    riskPerTradePct: 1,
    minConfidence: 0.6,
  });
  const aggressive = adaptiveProfile(s, {
    tradingMode: "aggressive",
    riskPerTradePct: 2,
    minConfidence: 0.9,
  });
  assert.equal(balanced.ready, true);
  assert.equal(balanced.regime, "trend");
  assert.equal(balanced.effectiveRiskPct, 0.25);
  assert.equal(balanced.minConfidence, 0.8);
  assert.equal(balanced.minRewardRisk, 1.5);
  assert.equal(aggressive.effectiveRiskPct, 0.25);
  assert.equal(aggressive.minConfidence, 0.9);
  assert.equal(aggressive.minRewardRisk, 1.5);
  assert.equal(balanced.scalpingEligible, true);
  assert.deepEqual(balanced.allowedStrategies, ["trend", "scalping", "wait"]);
  assert.equal(balanced.decisionTimeframe, "M1");
  assert.equal(balanced.decisionBarTime, s.timeframes.M1.bars.at(-1).time);
  assert.equal(balanced.frames.H1.barCount, 220);
  assert.equal(
    adaptiveProfile(s, { riskPerTradePct: 0.2 }).effectiveRiskPct,
    0.2,
  );
});

test("scalp permission depends on mode spread cost plus M1/M5 direction and momentum", () => {
  const s = snapshot();
  s.ask = s.bid + 0.2;
  assert.equal(adaptiveProfile(s).scalpingEligible, false);
  assert.match(adaptiveProfile(s).scalpingReason, /Spread/);
  assert.equal(
    adaptiveProfile(s, { tradingMode: "aggressive" }).scalpingEligible,
    true,
  );
  s.timeframes.M1.bars = candles(
    60,
    Array.from({ length: 220 }, (_, i) => 350 - i * 0.5),
  );
  const p = adaptiveProfile(s, { tradingMode: "aggressive" });
  assert.equal(p.scalpingEligible, false);
  assert.match(p.scalpingReason, /trends do not agree/);
  assert.ok(!p.allowedStrategies.includes("scalping"));
});

test("range and high volatility tighten risk while extreme volatility blocks every entry strategy", () => {
  const range = snapshot();
  range.timeframes.M5.bars = candles(300, Array(100).fill(100));
  range.bars = structuredClone(range.timeframes.M5.bars);
  const ranging = adaptiveProfile(range);
  assert.equal(ranging.regime, "range");
  assert.equal(ranging.effectiveRiskPct, 0.125);
  assert.ok(!ranging.allowedStrategies.includes("trend"));
  assert.ok(ranging.allowedStrategies.includes("reversal"));
  const high = snapshot();
  high.timeframes.M1.bars.at(-1).high += 20;
  assert.equal(adaptiveProfile(high).regime, "high-volatility");
  assert.equal(adaptiveProfile(high).effectiveRiskPct, 0.125);
  const extreme = snapshot();
  extreme.timeframes.M1.bars.at(-1).high += 100;
  const stopped = adaptiveProfile(extreme, { tradingMode: "aggressive" });
  assert.equal(stopped.ready, true);
  assert.equal(stopped.regime, "extreme-volatility");
  assert.equal(stopped.effectiveRiskPct, 0);
  assert.equal(stopped.scalpingEligible, false);
  assert.deepEqual(stopped.allowedStrategies, ["wait"]);
});
