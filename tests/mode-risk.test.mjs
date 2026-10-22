import { test } from "node:test";
import assert from "node:assert/strict";
import { market, NOW } from "./helpers.mjs";
import { orderRisk } from "../server/trading.mjs";
import { automaticIntent } from "../server/automation.mjs";
import { adaptiveProfile, decisionBar } from "../server/market.mjs";
import {
  defaultTradeSettings,
  validateTradeSettings,
} from "../server/trade-settings.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { MODEL } from "../server/ai-analysis.mjs";

// Numerical fixtures only: these tests never contact a model or a broker.
function context({
  funds = 20000,
  equity = funds,
  settings = {},
  broker = {},
} = {}) {
  const snapshot = { ...market(), balance: funds, equity };
  const preferences = validateTradeSettings(settings);
  const execution = {
    protocol: 4,
    engineVersion: ENGINE_VERSION,
    tickSize: 0.01,
    tickValue: 1,
    point: 0.01,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 10,
    stopLevel: 10,
    freezeLevel: 5,
    dayStartEquity: equity,
    dailyLoss: 0,
    peakEquity: equity,
    existingRisk: 0,
    freeMargin: equity,
    pendingOrders: 0,
    tradeAllowed: true,
    stopsVerified: true,
    newsVerified: true,
    newsBlocked: false,
    ...broker,
  };
  return {
    market: snapshot,
    execution,
    settings: preferences,
    profile: adaptiveProfile(snapshot, preferences),
    enabled: true,
    permissionActive: true,
    blockers: [],
    connectionBlockers: [],
    unresolved: null,
    revision: "fixture-settings-revision",
    i: { account_type: "demo" },
    now: NOW,
  };
}
function intent(ctx, patch = {}) {
  return {
    kind: "OPEN",
    side: "BUY",
    symbol: "XAUUSD",
    stop: 2095.2,
    takeProfit: 2110.2,
    maxLots: ctx.execution.maxVolume,
    ...patch,
  };
}
function provenance(ctx, patch = {}) {
  return {
    source: "ai",
    engineVersion: ENGINE_VERSION,
    analysisId: "fixture-analysis",
    signalExpiresAt: NOW + 60000,
    signalBarTime: decisionBar(ctx.market),
    signalStrategy: "trend",
    signalConfidence: 0.9,
    ...patch,
  };
}

test("adaptive sizing is the default and the old 0.01 preference does not cap it", () => {
  assert.equal(defaultTradeSettings.sizingMode, "adaptive");
  const ctx = context();
  assert.equal(ctx.settings.lotSize, 0.01);
  const approved = orderRisk(ctx, intent(ctx));
  assert.equal(approved.volume, 0.19);
  assert.ok(approved.volume > ctx.settings.lotSize);
  assert.ok(approved.riskAmount <= 100 + 1e-8);
  assert.equal(approved.riskPercent, 0.5);
});

test("lots rise and fall with verified funds, using the smaller of balance and equity", () => {
  for (const [funds, equity, expected] of [
    [10000, 10000, 0.09],
    [20000, 20000, 0.19],
    [40000, 40000, 0.39],
    [20000, 10000, 0.09],
    [10000, 20000, 0.09],
  ]) {
    const ctx = context({ funds, equity });
    const approved = orderRisk(ctx, intent(ctx));
    assert.equal(approved.volume, expected);
    assert.ok(approved.riskAmount <= Math.min(funds, equity) * 0.005 + 1e-8);
  }
});

test("Balanced and Aggressive keep their hard risk caps and honor lower configured risk", () => {
  for (const [settings, expectedRisk, expectedVolume] of [
    [{ tradingMode: "balanced" }, 0.5, 0.19],
    [{ tradingMode: "aggressive" }, 0.5, 0.19],
    [{ tradingMode: "balanced", riskPerTradePct: 0.2 }, 0.2, 0.07],
    [{ tradingMode: "aggressive", riskPerTradePct: 0.2 }, 0.2, 0.07],
  ]) {
    const ctx = context({ settings });
    const approved = orderRisk(ctx, intent(ctx));
    assert.equal(approved.riskPercent, expectedRisk);
    assert.equal(approved.volume, expectedVolume);
    assert.ok(approved.riskAmount <= (20000 * expectedRisk) / 100 + 1e-8);
  }
  assert.throws(() => validateTradeSettings({ riskPerTradePct: 0.501 }));
  assert.throws(() => validateTradeSettings({ sizingMode: "unlimited" }));
});

test("broker volume limits, explicit order caps, and an optional saved lot cap all restrict automatic sizing", () => {
  const broker = context({ broker: { maxVolume: 0.12 } });
  assert.equal(orderRisk(broker, intent(broker)).volume, 0.12);
  const explicit = context();
  assert.equal(
    orderRisk(explicit, intent(explicit, { maxLots: 0.04 })).volume,
    0.04,
  );
  const capped = context({ settings: { sizingMode: "capped", lotSize: 0.01 } });
  assert.equal(orderRisk(capped, intent(capped)).volume, 0.01);
  const capAboveBudget = context({
    settings: { sizingMode: "capped", lotSize: 1 },
  });
  assert.equal(orderRisk(capAboveBudget, intent(capAboveBudget)).volume, 0.19);
});

test("risky volatility reduces the risk budget instead of forcing the broker minimum", () => {
  const ctx = context();
  // Enlarge only the latest closed range: the real feature calculator classifies it.
  for (const frame of Object.values(ctx.market.timeframes)) {
    frame.bars.at(-1).high += 15;
    frame.bars.at(-1).low -= 15;
  }
  ctx.market.bars = structuredClone(ctx.market.timeframes.M5.bars);
  ctx.profile = adaptiveProfile(ctx.market, ctx.settings);
  assert.ok(ctx.profile.effectiveRiskPct < 0.5);
  if (ctx.profile.effectiveRiskPct === 0) {
    assert.throws(() => orderRisk(ctx, intent(ctx)));
  } else {
    const approved = orderRisk(ctx, intent(ctx));
    assert.ok(approved.volume < 0.19);
    assert.ok(
      approved.riskAmount <=
        (20000 * ctx.profile.effectiveRiskPct) / 100 + 1e-8,
    );
  }
  const small = context({ funds: 100 });
  assert.throws(
    () => orderRisk(small, intent(small)),
    /Minimum lot exceeds risk budget/,
  );
});

test("daily loss, drawdown and aggregate exposure remain hard blocks with adaptive sizing", () => {
  for (const [broker, reason] of [
    [{ dailyLoss: 1000 }, /Daily loss/],
    [{ peakEquity: 22000 }, /Drawdown/],
    [{ existingRisk: 590 }, /Aggregate exposure/],
  ]) {
    const ctx = context({ broker });
    assert.throws(() => orderRisk(ctx, intent(ctx)), reason);
  }
});

test("untrusted sizing, permissions and AI provenance never survive the approved order whitelist", () => {
  const ctx = context();
  const approved = orderRisk(
    ctx,
    intent(ctx, {
      ...provenance(ctx),
      riskPercent: 100,
      riskPerTradePct: 100,
      volume: 10,
      liveConfirmed: true,
      demoValidated: true,
      originTerminal: "attacker",
    }),
  );
  assert.equal(approved.volume, 0.19);
  assert.equal(approved.riskPercent, 0.5);
  for (const key of [
    "source",
    "analysisId",
    "signalConfidence",
    "engineVersion",
    "liveConfirmed",
    "demoValidated",
    "originTerminal",
    "riskPerTradePct",
  ])
    assert.equal(approved[key], undefined, key);
});

test("authorization repeats current confidence, protective distance and reward-to-risk checks", () => {
  const ctx = context();
  const order = intent(ctx, provenance(ctx));
  assert.doesNotThrow(() => orderRisk(ctx, order));
  ctx.profile.minConfidence = 0.95;
  assert.throws(() => orderRisk(ctx, order), /confidence/);
  ctx.profile.minConfidence = 0.8;
  ctx.market.bid -= 0.05;
  ctx.market.ask -= 0.05;
  assert.throws(() => orderRisk(ctx, order), /protective distances/);
  const rr = context({ settings: { takeProfitPoints: 500 } });
  const marginal = intent(rr, { ...provenance(rr), takeProfit: 2107.7 });
  assert.doesNotThrow(() => orderRisk(rr, marginal));
  rr.market.bid += 0.05;
  rr.market.ask += 0.05;
  assert.throws(() => orderRisk(rr, marginal), /selected AI mode/);
});

test("automatic intent respects AI proposed lots and broker maximum while risk can only reduce actual volume", () => {
  const ctx = context();
  const assessment = {
    model: MODEL,
    engineVersion: ENGINE_VERSION,
    expiresAt: NOW + 60000,
    settingsRevision: ctx.revision,
    symbol: ctx.market.symbol,
    decision: "BUY",
    confidence: 0.9,
    strategy: "trend",
    entryPrice: ctx.market.ask,
    stopLoss: 2095.2,
    takeProfit: 2110.2,
    proposedLots: ctx.execution.maxVolume,
    entryAction: "OPEN",
    positionActions: [],
  };
  let order = automaticIntent(ctx, assessment);
  assert.equal(order.maxLots, ctx.execution.maxVolume);
  assert.equal(orderRisk(ctx, order).volume, 0.19);
  ctx.settings = { ...ctx.settings, sizingMode: "capped" };
  order = automaticIntent(ctx, assessment);
  assert.equal(order.maxLots, 0.01);
  assert.equal(orderRisk(ctx, order).volume, 0.01);
});
