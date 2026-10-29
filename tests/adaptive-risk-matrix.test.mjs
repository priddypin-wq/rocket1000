import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRisk } from "../lib/risk.mjs";
import { validateExecution, orderRisk } from "../server/trading.mjs";
import { validateTradeSettings } from "../server/trade-settings.mjs";
import { adaptiveProfile } from "../server/market.mjs";
import { market, NOW } from "./helpers.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// Numerical and protocol fixtures only. No model, terminal or broker is called.
function snapshot(patch = {}) {
  return {
    balance: 10000,
    equity: 10000,
    dayStartEquity: 10000,
    dailyLoss: 0,
    openPositions: 0,
    entry: 2000,
    stop: 1990,
    tickSize: 0.01,
    tickValue: 1,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 100,
    spread: 10,
    maxSpread: 30,
    slippage: 0,
    maxSlippage: 10,
    existingRisk: 0,
    peakEquity: 10000,
    maxDrawdown: 0.05,
    freeMargin: 10000,
    commissionPerLot: 0,
    connected: true,
    mode: "demo",
    demoAuthorized: true,
    safetyVerified: true,
    newsVerified: true,
    newsBlocked: false,
    side: "BUY",
    ...patch,
  };
}
function assertBudget(s, r) {
  if (!r.approved) {
    assert.equal(r.volume, 0);
    assert.ok(r.reasons.length);
    return;
  }
  const loss =
    (Math.abs(s.entry - s.stop) / s.tickSize) * s.tickValue +
    s.commissionPerLot;
  const capital = Math.min(s.balance, s.equity);
  assert.ok(r.volume >= s.minVolume && r.volume <= s.maxVolume);
  assert.ok(
    Math.abs(r.volume / s.volumeStep - Math.round(r.volume / s.volumeStep)) <=
      1e-5,
  );
  assert.ok(r.volume * loss <= capital * (s.riskPerTrade ?? 0.0025) + 1e-8);
  assert.ok(
    s.existingRisk + r.volume * loss <=
      capital * (s.aggregateLimit ?? 0.0025) + 1e-8,
  );
}

test("adaptive account/stop/volume matrix always preserves fixed per-trade and aggregate budgets", () => {
  let approved = 0,
    skipped = 0;
  for (const funds of [10, 100, 1000, 10000, 100000, 1000000])
    for (const distance of [1, 5, 10, 50])
      for (const step of [0.001, 0.01, 0.1, 0.25, 1]) {
        const s = snapshot({
          balance: funds,
          equity: funds,
          peakEquity: funds,
          dayStartEquity: funds,
          freeMargin: funds,
          stop: 2000 - distance,
          minVolume: step,
          volumeStep: step,
        });
        const r = validateRisk(s);
        assertBudget(s, r);
        if (r.approved) approved++;
        else skipped++;
      }
  assert.ok(
    approved > 0 && skipped > 0,
    "matrix must exercise approvals and budget skips",
  );
});

test("doubling verified account funds scales size without increasing risk percentage", () => {
  let prior = 0;
  for (const funds of [10000, 20000, 40000, 80000]) {
    const s = snapshot({
      balance: funds,
      equity: funds,
      peakEquity: funds,
      dayStartEquity: funds,
      freeMargin: funds,
    });
    const r = validateRisk(s);
    assert.equal(r.riskBudget / funds, 0.0025);
    assert.ok(r.volume >= prior);
    assertBudget(s, r);
    prior = r.volume;
  }
  for (const [balance, equity] of [
    [10000, 20000],
    [20000, 10000],
  ]) {
    const s = snapshot({
      balance,
      equity,
      peakEquity: equity,
      dayStartEquity: equity,
    });
    const r = validateRisk(s);
    assert.equal(r.riskBudget, 25);
    assert.equal(r.volume, 0.02);
  }
});

test("wider protective distances and greater verified transaction costs can only reduce size", () => {
  let previous = Infinity;
  for (const distance of [1, 2, 5, 10, 20]) {
    const s = snapshot({ stop: 2000 - distance });
    const r = validateRisk(s);
    assert.ok(r.volume <= previous);
    assertBudget(s, r);
    previous = r.volume;
  }
  previous = Infinity;
  for (const commissionPerLot of [0, 5, 50, 250, 1000]) {
    const s = snapshot({ commissionPerLot });
    const r = validateRisk(s);
    assert.ok(r.volume <= previous);
    assertBudget(s, r);
    previous = r.volume;
  }
});

test("BUY and SELL size symmetrically from their actual protective stop distances", () => {
  const buy = validateRisk(snapshot());
  const sell = validateRisk(snapshot({ side: "SELL", stop: 2010 }));
  assert.equal(buy.volume, sell.volume);
  assert.equal(buy.riskBudget, sell.riskBudget);
  assert.equal(
    validateRisk(snapshot({ side: "SELL", stop: 1990 })).approved,
    false,
  );
});

test("remaining aggregate capacity restricts sizing and never rounds the broker minimum up", () => {
  let previous = Infinity;
  for (const existingRisk of [0, 1, 5, 10, 15, 24, 25, 26]) {
    const s = snapshot({ existingRisk });
    const r = validateRisk(s);
    assert.equal(r.riskBudget, Math.max(0, 25 - existingRisk));
    assert.ok(r.volume <= previous);
    assertBudget(s, r);
    previous = r.volume;
  }
  const s = snapshot({
    balance: 100,
    equity: 100,
    peakEquity: 100,
    dayStartEquity: 100,
  });
  assert.equal(validateRisk(s).approved, false);
  assert.equal(validateRisk({ ...s, minVolume: 0.1 }).approved, false);
});

test("supplied free-margin failures are closed at the pure risk boundary", () => {
  for (const freeMargin of [0, -1, NaN, Infinity, null, "10000"])
    assert.equal(
      validateRisk(snapshot({ freeMargin })).approved,
      false,
      String(freeMargin),
    );
  // Positive free margin is availability evidence, not an invented leverage or
  // margin estimate. The EA must still pass its real OrderCalcMargin/OrderCheck.
  for (const freeMargin of [0.01, 100, 10000])
    assert.equal(validateRisk(snapshot({ freeMargin })).approved, true);
});

test("wire precision cannot round a subminimum risk allocation into a larger order", () => {
  const s = snapshot({
    balance: 3.6,
    equity: 3.6,
    dayStartEquity: 3.6,
    peakEquity: 3.6,
    entry: 2,
    stop: 1,
    tickSize: 1,
    tickValue: 1000000,
    volumeStep: 1e-9,
    minVolume: 1e-9,
    maxVolume: 1,
  });
  assert.equal(validateRisk(s).approved, false);
  assert.equal(validateRisk(s).volume, 0);
  const offStep = {
    ...s,
    balance: 10,
    equity: 10,
    dayStartEquity: 10,
    peakEquity: 10,
    volumeStep: 1.5e-8,
    minVolume: 1.5e-8,
  };
  assert.equal(validateRisk(offStep).approved, false);
});

test("account loss, drawdown, spread and permission failures cannot be solved by larger funds", () => {
  for (const funds of [1000, 10000, 1000000])
    for (const patch of [
      { dailyLoss: funds * 0.01 },
      { equity: funds * 0.95 },
      { openPositions: 1 },
      { spread: 31 },
      { slippage: 11 },
      { connected: false },
      { demoAuthorized: false },
      { safetyVerified: false },
      { newsBlocked: true },
      { mode: "live", liveAuthorized: false },
    ]) {
      const s = snapshot({
        balance: funds,
        equity: funds,
        peakEquity: funds,
        dayStartEquity: funds,
        ...patch,
      });
      assert.equal(validateRisk(s).approved, false);
    }
});

test("lower operator risk policies constrain adaptation and invalid hard ceilings fail closed", () => {
  for (const riskPerTrade of [0.0005, 0.001, 0.0025])
    for (const aggregateLimit of [0.0005, 0.001, 0.0025]) {
      const s = snapshot({ riskPerTrade, aggregateLimit });
      assertBudget(s, validateRisk(s));
    }
  for (const patch of [
    { riskPerTrade: 0.00251 },
    { aggregateLimit: 0.00251 },
    { dailyLossLimit: 0.01001 },
    { positionLimit: 2 },
    { maxDrawdown: 0.05001 },
  ])
    assert.equal(validateRisk(snapshot(patch)).approved, false);
  for (const patch of [
    { riskPerTradePct: 0.251 },
    { maxAggregateRiskPct: 0.251 },
    { maxDailyLossPct: 1.001 },
    { maxDrawdownPct: 5.001 },
    { maxPositions: 2 },
  ])
    assert.throws(() => validateTradeSettings(patch));
});

test("actual backend order sizing includes slippage and costs and accepts supported broker steps", () => {
  for (const funds of [1000, 10000, 100000])
    for (const volumeStep of [0.001, 0.01, 0.1]) {
      const m = { ...market(NOW), balance: funds, equity: funds };
      const settings = validateTradeSettings({});
      const e = {
        protocol: 4,
        engineVersion: ENGINE_VERSION,
        point: 0.01,
        tickSize: 0.01,
        tickValue: 1,
        volumeStep,
        minVolume: volumeStep,
        maxVolume: 100,
        stopLevel: 10,
        freezeLevel: 5,
        dayStartEquity: funds,
        dailyLoss: 0,
        peakEquity: funds,
        existingRisk: 0,
        freeMargin: funds,
        pendingOrders: 0,
        tradeAllowed: true,
        stopsVerified: true,
        costsVerified: true,
        commissionPerLot: 7,
        consecutiveLosses: 0,
        consecutiveLossesVerified: true,
        newsVerified: true,
        newsBlocked: false,
      };
      const ctx = {
        market: m,
        execution: e,
        settings,
        profile: adaptiveProfile(m, settings),
        enabled: true,
        permissionActive: true,
        blockers: [],
        connectionBlockers: [],
        unresolved: null,
        revision: "adaptive-matrix",
        i: { account_type: "demo" },
        now: NOW,
      };
      const order = {
        kind: "OPEN",
        side: "BUY",
        symbol: m.symbol,
        stop: 2095.2,
        takeProfit: 2110.2,
        maxLots: e.maxVolume,
      };
      try {
        const result = orderRisk(ctx, order);
        assert.ok(result.riskAmount <= funds * 0.0025 + 1e-8);
        // Five price units to SL = 500 per lot, plus 20 of conservative
        // entry/exit slippage and seven of verified round-trip commission.
        assert.ok(Math.abs(result.riskAmount - result.volume * 527) < 1e-8);
        assert.ok(
          Math.abs(
            result.volume / volumeStep - Math.round(result.volume / volumeStep),
          ) <= 1e-5,
        );
        const rejectedMargin = { ...ctx, execution: { ...e, freeMargin: 0 } };
        assert.throws(() => orderRisk(rejectedMargin, order), /free margin/i);
      } catch (error) {
        assert.match(error.message, /Minimum lot exceeds risk budget/);
      }
      assert.throws(
        () => validateExecution({ ...e, freeMargin: -1 }),
        /incomplete/,
      );
    }
});
