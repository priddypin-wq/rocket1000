import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceActionFeatures,
  selectedStrategyProfile,
  strategyContext,
  smartMoneyFeatures,
} from "../server/strategy.mjs";
import {
  validateTradeSettings,
  defaultTradeSettings,
  tradeSettings,
} from "../server/trade-settings.mjs";
import { automaticIntent } from "../server/automation.mjs";
import { MODEL, analyzeMarket } from "../server/ai-analysis.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { fixture, market, NOW, decision } from "./helpers.mjs";

test("closed-candle price action calculates actual breakouts, retests and confirmations without charts", () => {
  const bars = Array.from({ length: 25 }, (_, i) => ({
    time: i + 1,
    open: 100,
    high: 102,
    low: 98,
    close: 101,
  }));
  bars[23] = { ...bars[23], open: 101, high: 105, close: 104 };
  bars[24] = { ...bars[24], open: 102, high: 106, low: 101, close: 105 };
  let p = priceActionFeatures(bars);
  assert.equal(p.support, 98);
  assert.equal(p.resistance, 102);
  assert.equal(p.breakout, "above-resistance");
  assert.equal(p.retest, "resistance-held-as-support");
  assert.equal(p.candle.direction, "bullish");
  assert.equal(p.structure, "insufficient-confirmed-swings");
  bars[23] = { ...bars[23], open: 100, low: 95, high: 101, close: 96 };
  bars[24] = { ...bars[24], open: 98, low: 94, high: 99, close: 95 };
  p = priceActionFeatures(bars);
  assert.equal(p.retest, "support-held-as-resistance");
  assert.equal(p.breakout, "below-support");
  assert.equal(priceActionFeatures(bars.slice(0, 10)), null);
  assert.equal(
    priceActionFeatures([...bars.slice(0, 24), { ...bars[24], close: NaN }]),
    null,
  );
});

function geometricCandles() {
  return Array.from({ length: 25 }, (_, i) => ({
    time: i + 1,
    open: 100,
    high: 102,
    low: 98,
    close: 101,
  }));
}

test("SMC observations distinguish actual closed-candle gaps, displacement zones and later mitigation", () => {
  const bars = geometricCandles();
  bars[22] = { time: 23, open: 101, high: 102, low: 98, close: 99 };
  bars[23] = { time: 24, open: 99, high: 108, low: 98, close: 107 };
  bars[24] = { time: 25, open: 106, high: 110, low: 105, close: 109 };
  const initial = smartMoneyFeatures(bars);
  assert.equal(initial.statisticallyValidated, false);
  assert.deepEqual(initial.fairValueGaps.at(-1), {
    side: "bullish",
    lower: 102,
    upper: 105,
    formedAt: 25,
    status: "unfilled",
  });
  assert.deepEqual(initial.orderBlocks.at(-1), {
    side: "bullish",
    lower: 98,
    upper: 102,
    originTime: 23,
    confirmedAt: 24,
    status: "untested",
  });
  bars.push({ time: 26, open: 106, high: 108, low: 101, close: 103 });
  let observed = smartMoneyFeatures(bars);
  assert.equal(
    observed.fairValueGaps.find((g) => g.formedAt === 25).status,
    "filled",
  );
  assert.equal(
    observed.orderBlocks.find((b) => b.originTime === 23).status,
    "revisited",
  );
  bars.push({ time: 27, open: 102, high: 103, low: 95, close: 97 });
  observed = smartMoneyFeatures(bars);
  assert.equal(
    observed.orderBlocks.find((b) => b.originTime === 23).status,
    "invalidated",
  );
  assert.equal(observed.observedThrough, 27);
  assert.equal(
    initial.orderBlocks.at(-1).status,
    "untested",
    "later candles must not mutate an earlier assessment",
  );
});

test("bearish geometric patterns are symmetric and invalid or unordered data never creates observations", () => {
  const bullish = geometricCandles();
  bullish[22] = { time: 23, open: 101, high: 102, low: 98, close: 99 };
  bullish[23] = { time: 24, open: 99, high: 108, low: 98, close: 107 };
  bullish[24] = { time: 25, open: 106, high: 110, low: 105, close: 109 };
  const bearish = bullish.map((b) => ({
    ...b,
    open: 200 - b.open,
    high: 200 - b.low,
    low: 200 - b.high,
    close: 200 - b.close,
  }));
  const observations = smartMoneyFeatures(bearish);
  assert.equal(observations.fairValueGaps.at(-1).side, "bearish");
  assert.equal(observations.orderBlocks.at(-1).side, "bearish");
  for (const malformed of [
    bullish.slice(0, 24),
    [...bullish].reverse(),
    [...bullish.slice(0, 24), { ...bullish[24], low: -1 }],
    [...bullish.slice(0, 24), { ...bullish[24], high: Infinity }],
  ]) {
    assert.equal(smartMoneyFeatures(malformed), null);
    assert.equal(priceActionFeatures(malformed), null);
  }
});

test("liquidity sweep labels use prior levels and explicitly do not imply a calibrated win probability", () => {
  const bars = geometricCandles();
  bars[24] = { time: 25, open: 99, high: 101, low: 96, close: 100 };
  const observed = smartMoneyFeatures(bars);
  assert.deepEqual(observed.liquiditySweeps.at(-1), {
    side: "sell-side",
    referenceLevel: 98,
    extreme: 96,
    close: 100,
    time: 25,
  });
  assert.ok(observed.reversalPatterns.includes("bullishRejection"));
  const context = strategyContext({
    ask: 100.5,
    bid: 100.3,
    timeframes: { M1: { bars: geometricCandles() } },
  });
  assert.equal(context.observedRewardRisk.M1.buy, 0.6);
  assert.equal(context.tradeProbability.value, null);
  assert.equal(context.tradeProbability.statisticallyValidated, false);
  assert.deepEqual(context.economicNews, { connected: false, events: null });
  assert.equal(
    strategyContext({ timeframes: {} }).observedRewardRisk.M1,
    undefined,
  );
});

test("old saved risk preferences are tightened to the new half-percent policy while lower limits survive", async () => {
  const f = await fixture();
  try {
    for (const [saved, expected] of [
      [1, 0.5],
      [0.2, 0.2],
    ]) {
      await f.db.query(
        "INSERT INTO rocket_trade_preferences(connection_id,revision,payload) VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET payload=excluded.payload",
        [
          f.id,
          "legacy-risk-revision",
          JSON.stringify({ ...defaultTradeSettings, riskPerTradePct: saved }),
        ],
      );
      const current = await tradeSettings(f.db, f.id);
      assert.equal(current.settings.riskPerTradePct, expected);
      assert.equal(current.revision, "legacy-risk-revision");
    }
    assert.throws(() => validateTradeSettings({ riskPerTradePct: 0.500001 }));
    assert.equal(
      validateTradeSettings({ riskPerTradePct: 0.1 }).riskPerTradePct,
      0.1,
    );
  } finally {
    await f.db.close();
  }
});

const profile = {
  ready: true,
  effectiveRiskPct: 0.5,
  minConfidence: 0.8,
  minRewardRisk: 1.5,
  allowedStrategies: ["trend", "reversal", "scalping", "wait"],
  scalpingEligible: true,
  scalpingSide: "BUY",
};
const execution = {
  protocol: 4,
  engineVersion: ENGINE_VERSION,
  point: 0.01,
  tickSize: 0.01,
  stopLevel: 10,
  freezeLevel: 5,
  maxVolume: 10,
  sessionOpen: true,
  tradeAllowed: true,
  symbolTradeMode: 4,
  tradeExecutionMode: 2,
  orderMode: 49,
};
test("selected strategy can only narrow market permissions and closed/unknown sessions block scalping", () => {
  const s = market();
  assert.deepEqual(
    selectedStrategyProfile(s, { strategy: "price-action" }, profile, execution)
      .allowedStrategies,
    ["trend", "reversal", "wait"],
  );
  assert.deepEqual(
    selectedStrategyProfile(s, { strategy: "scalping" }, profile, execution)
      .allowedStrategies,
    ["scalping", "wait"],
  );
  for (const e of [
    {},
    { ...execution, sessionOpen: false },
    { ...execution, tradeAllowed: false },
    { ...execution, symbolTradeMode: 3 },
  ]) {
    assert.deepEqual(
      selectedStrategyProfile(s, { strategy: "scalping" }, profile, e)
        .allowedStrategies,
      ["wait"],
    );
  }
  assert.deepEqual(
    selectedStrategyProfile(
      s,
      {},
      { ...profile, allowedStrategies: ["wait"] },
      execution,
    ).allowedStrategies,
    ["wait"],
  );
  assert.equal(validateTradeSettings({}).strategy, "adaptive");
  assert.equal(
    validateTradeSettings({ strategy: "price-action", breakEvenPoints: 0 })
      .breakEvenPoints,
    0,
  );
  for (const value of [
    { strategy: "random" },
    { breakEvenPoints: -1 },
    { riskPerTradePct: 1.1 },
    { maxPositions: 4 },
  ])
    assert.throws(() => validateTradeSettings(value));
});

function context(patch = {}) {
  return {
    now: NOW,
    revision: "revision",
    enabled: true,
    market: market(),
    profile,
    execution,
    settings: {
      ...defaultTradeSettings,
      trailingStopPoints: 0,
      breakEvenPoints: 100,
    },
    ...patch,
  };
}
function signal(ctx) {
  return {
    model: MODEL,
    engineVersion: ENGINE_VERSION,
    settingsRevision: ctx.revision,
    symbol: ctx.market.symbol,
    decision: "BUY",
    strategy: "trend",
    timeframe: "M1",
    confidence: 0.95,
    entryPrice: ctx.market.ask,
    stopLoss: ctx.market.ask - 5,
    takeProfit: ctx.market.ask + 10,
    expiresAt: NOW + 60000,
    entryAction: "OPEN",
    proposedLots: 0.1,
    positionActions: [],
  };
}
function position(side = "BUY", patch = {}) {
  return {
    managed: true,
    ticket: "1",
    symbol: "XAUUSD",
    side,
    open: side === "BUY" ? 2098 : 2102,
    stop: side === "BUY" ? 2090 : 2110,
    takeProfit: side === "BUY" ? 2120 : 2080,
    ...patch,
  };
}
test("no trailing, break-even or opposite-signal exit is invented without an explicit AI position action", () => {
  for (const side of ["BUY", "SELL"]) {
    const ctx = context();
    const p = position(side);
    ctx.market.positions = [p];
    assert.equal(automaticIntent(ctx, null), null);
    const proposed = {
      ...signal(ctx),
      positionActions: [
        {
          kind: "MODIFY",
          position: p.ticket,
          volume: null,
          stopLoss: p.open,
          takeProfit: p.takeProfit,
          reasoning: "AI protective proposal fixture",
        },
      ],
    };
    const intent = automaticIntent(ctx, proposed);
    assert.equal(intent.kind, "MODIFY");
    assert.equal(intent.stop, p.open);
    ctx.market.positions = [{ ...p, stop: p.open }];
    assert.equal(automaticIntent(ctx, proposed), null);
    ctx.market.positions = [{ ...p, managed: false }];
    assert.equal(automaticIntent(ctx, proposed), null);
    ctx.market.positions = [p];
    assert.equal(
      automaticIntent(ctx, {
        ...signal(ctx),
        decision: side === "BUY" ? "SELL" : "BUY",
      }),
      null,
    );
  }
});
test("protective management scans all owned positions; WAIT cannot create an order", () => {
  const ctx = context();
  ctx.market.positions = [
    position("BUY", { ticket: "1", stop: 2098 }),
    position("BUY", { ticket: "2" }),
  ];
  assert.equal(
    automaticIntent(ctx, {
      ...signal(ctx),
      positionActions: [
        { kind: "MODIFY", position: "1", stopLoss: 2098, takeProfit: 2120 },
        { kind: "MODIFY", position: "2", stopLoss: 2098, takeProfit: 2120 },
      ],
    }).position,
    "2",
  );
  ctx.market.positions = [];
  const assessment = signal(ctx);
  assert.equal(automaticIntent(ctx, { ...assessment, decision: "WAIT" }), null);
  assert.equal(automaticIntent(ctx, assessment).kind, "OPEN");
  ctx.settings.strategy = "scalping";
  assert.equal(automaticIntent(ctx, assessment), null);
});
test("AI context uses broker data and derived strategy observations without account identifiers or order authority", async () => {
  let input;
  await analyzeMarket(market(), {
    now: () => NOW,
    env: { OPENAI_API_KEY: "unit-test-only" },
    settings: { ...defaultTradeSettings, strategy: "price-action" },
    execution,
    fetcher: async (_url, options) => {
      input = JSON.parse(JSON.parse(options.body).input);
      return Response.json({
        id: "resp_fixture",
        status: "completed",
        model: MODEL,
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(decision) }],
          },
        ],
      });
    },
  });
  assert.equal(input.selectedStrategy, "price-action");
  assert.deepEqual(Object.keys(input.priceAction), ["M1", "M5", "M15", "H1"]);
  assert.equal(
    input.priceAction.M1.barTime,
    market().timeframes.M1.bars.at(-1).time,
  );
  assert.equal(input.brokerConditions.sessionOpen, true);
  assert.ok(!input.allowedStrategies.includes("scalping"));
  for (const name of [
    "balance",
    "equity",
    "accountLogin",
    "credential",
    "positions",
    "lots",
  ])
    assert.equal(input[name], undefined);
  assert.equal(strategyContext(market()).brokerConditions.sessionOpen, null);
});
