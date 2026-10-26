import { test } from "node:test";
import assert from "node:assert/strict";
import { winningAdditionAllowed } from "../server/winning-additions.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { market, NOW } from "./helpers.mjs";
import { adaptiveProfile, decisionBar } from "../server/market.mjs";
import { validateTradeSettings } from "../server/trade-settings.mjs";
import { orderRisk, validateExecution } from "../server/trading.mjs";

// Deterministic backend-boundary fixtures. No broker requests or model calls.
function context(side = "BUY") {
  const settings = validateTradeSettings({ tradingMode: "aggressive" });
  const m = market(NOW);
  m.positions = [
    {
      symbol: m.symbol,
      side,
      ticket: "1234567890123456789",
      identifier: "2234567890123456789",
      magic: 100061,
      comment: "R1000:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".slice(0, 30),
      ownedIntegrity: true,
      managed: true,
      open: side === "BUY" ? 2099 : 2102,
      stop: side === "BUY" ? 2099 : 2102,
      takeProfit: side === "BUY" ? 2115 : 2080,
      profit: 5,
      volume: 0.01,
    },
  ];
  const execution = {
    protocol: 4,
    engineVersion: ENGINE_VERSION,
    accountMarginMode: 2,
    positionsAvailable: true,
    terminalId: "0123456789abcdef01234567",
    tickSize: 0.01,
    tickValue: 1,
    point: 0.01,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 10,
    stopLevel: 10,
    dayStartEquity: 18432.81,
    dailyLoss: 7.18,
    peakEquity: 18432.81,
    existingRisk: 0,
    freeMargin: 18000,
    pendingOrders: 0,
    tradeAllowed: true,
    stopsVerified: true,
    costsVerified: true,
    commissionPerLot: 0,
    consecutiveLosses: 0,
    consecutiveLossesVerified: true,
    newsVerified: true,
    newsBlocked: false,
  };
  return {
    now: NOW,
    market: m,
    execution,
    settings,
    profile: adaptiveProfile(m, settings),
    i: { account_type: "demo" },
    revision: "test-revision",
    blockers: [],
    connectionBlockers: [],
    enabled: true,
    permissionActive: true,
    unresolved: null,
  };
}
function entry(side = "BUY") {
  return {
    kind: "OPEN",
    symbol: "XAUUSD",
    side,
    stop: side === "BUY" ? 2095 : 2105,
    takeProfit: side === "BUY" ? 2111 : 2089,
    maxLots: 10,
  };
}

for (const side of ["BUY", "SELL"])
  test(`${side}: the one-position hard policy blocks additions even to a protected winner`, () => {
    const ctx = context(side);
    assert.equal(ctx.settings.maxPositions, 1);
    assert.equal(winningAdditionAllowed(ctx, side), false);
    assert.throws(() => orderRisk(ctx, entry(side)), /position|hedging/i);
  });

for (const [name, mutate] of [
  ["netting", (c) => (c.execution.accountMarginMode = 0)],
  ["exchange netting", (c) => (c.execution.accountMarginMode = 1)],
  ["unknown margin mode", (c) => delete c.execution.accountMarginMode],
  [
    "incomplete position enumeration",
    (c) => (c.execution.positionsAvailable = false),
  ],
  ["old engine", (c) => (c.execution.engineVersion = "old")],
  ["stale snapshot", (c) => (c.market.timestamp = NOW - 30001)],
  ["stale quote", (c) => (c.market.quoteTimestamp = NOW - 15001)],
  ["future quote", (c) => (c.market.quoteTimestamp = NOW + 2001)],
  ["external position", (c) => (c.market.positions[0].managed = false)],
  ["mixed ownership", (c) => (c.market.positions[0].ownedIntegrity = false)],
  ["manual magic", (c) => (c.market.positions[0].magic = 0)],
  ["opposite position", (c) => (c.market.positions[0].side = "SELL")],
  ["unprotected position", (c) => (c.market.positions[0].stop = 0)],
  ["stop below break-even", (c) => (c.market.positions[0].stop = 2098)],
  ["losing position", (c) => (c.market.positions[0].profit = -1)],
  ["flat position", (c) => (c.market.positions[0].profit = 0)],
  [
    "unfavorable executable price",
    (c) => {
      c.market.positions[0].open = 2101;
      c.market.positions[0].stop = 2101;
    },
  ],
  [
    "aggregate risk ceiling",
    (c) =>
      (c.execution.existingRisk =
        Math.min(c.market.balance, c.market.equity) * 0.03),
  ],
  ["lower user position cap", (c) => (c.settings.maxPositions = 1)],
])
  test(`winning additions reject ${name}`, () => {
    const ctx = context();
    mutate(ctx);
    assert.equal(winningAdditionAllowed(ctx, "BUY"), false);
  });

test("first entries enforce quarter-percent aggregate risk and never round a minimum lot up", () => {
  const ctx = context();
  ctx.market.positions = [];
  ctx.execution.existingRisk =
    Math.min(ctx.market.balance, ctx.market.equity) * 0.00249;
  assert.throws(
    () => orderRisk(ctx, entry()),
    /Minimum lot exceeds risk budget/,
  );
  ctx.execution.existingRisk = 0;
  ctx.execution.minVolume = 100;
  ctx.execution.maxVolume = 100;
  ctx.execution.volumeStep = 1;
  assert.throws(
    () => orderRisk(ctx, { ...entry(), maxLots: 100 }),
    /Minimum lot exceeds risk/,
  );
});

test("first entries on netting accounts remain possible; the exception never authorizes a trade by itself", () => {
  const ctx = context();
  ctx.execution.accountMarginMode = 0;
  ctx.market.positions = [];
  assert.equal(winningAdditionAllowed(ctx, "BUY"), true);
  ctx.enabled = false;
  assert.throws(() => orderRisk(ctx, entry()), /enable orders/);
});
test("MT5 margin-mode telemetry accepts native values and rejects invented modes", () => {
  const x = context().execution;
  for (const value of [0, 1, 2])
    assert.equal(
      validateExecution({ ...x, accountMarginMode: value }).accountMarginMode,
      value,
    );
  for (const value of [-1, 3, 2.5, "2"])
    assert.throws(
      () => validateExecution({ ...x, accountMarginMode: value }),
      /margin mode/,
    );
});
test("the authoritative AI boundary rejects a signal excluded by the selected strategy", () => {
  const ctx = context();
  ctx.market.positions = [];
  ctx.settings.strategy = "price-action";
  assert.throws(
    () =>
      orderRisk(ctx, {
        ...entry(),
        source: "ai",
        engineVersion: ENGINE_VERSION,
        signalExpiresAt: NOW + 60000,
        signalBarTime: decisionBar(ctx.market),
        signalStrategy: "scalping",
        signalConfidence: 0.99,
      }),
    /strategy/,
  );
});

test("entry loss and position-count limits do not prevent an authorized risk-reducing close or stop tightening", () => {
  const ctx = context(),
    p = ctx.market.positions[0];
  ctx.enabled = false;
  ctx.blockers = ["Daily loss limit reached.", "Maximum 1 open position."];
  ctx.execution.dailyLoss = ctx.execution.dayStartEquity * 0.01;
  assert.equal(
    orderRisk(ctx, { kind: "CLOSE", position: p.ticket }).kind,
    "CLOSE",
  );
  assert.equal(
    orderRisk(ctx, {
      kind: "MODIFY",
      position: p.ticket,
      stop: 2099.2,
      takeProfit: p.takeProfit,
    }).kind,
    "MODIFY",
  );
  ctx.permissionActive = false;
  assert.throws(
    () => orderRisk(ctx, { kind: "CLOSE", position: p.ticket }),
    /permission/,
  );
});
