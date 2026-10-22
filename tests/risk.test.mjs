import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRisk } from "../lib/risk.mjs";
const safe = {
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
  maxVolume: 10,
  spread: 10,
  maxSpread: 30,
  slippage: 0,
  maxSlippage: 10,
  existingRisk: 0,
  peakEquity: 10000,
  maxDrawdown: 0.05,
  connected: true,
  mode: "live",
  liveAuthorized: true,
  safetyVerified: true,
  newsVerified: true,
  newsBlocked: false,
  side: "BUY",
};
test("sizes at at most half a percent and rounds down", () => {
  const r = validateRisk(safe);
  assert.equal(r.approved, true);
  assert.equal(r.volume, 0.05);
  assert.equal(r.riskBudget, 50);
});
for (const [label, patch] of Object.entries({
  demo: { mode: "demo" },
  unauthorized: { liveAuthorized: false },
  disconnected: { connected: false },
  news: { newsVerified: false },
  dailyLoss: { dailyLoss: 500 },
  positions: { openPositions: 3 },
  stop: { stop: 2001 },
  drawdown: { equity: 9500 },
  spread: { spread: 31 },
  exposure: { existingRisk: 251 },
  excessiveRisk: { riskPerTrade: 0.00501 },
  invalid: { tickValue: NaN },
  negative: { dailyLoss: -1 },
  zeroStop: { stop: 0 },
  unverified: { safetyVerified: false },
}))
  test(`rejects ${label}`, () =>
    assert.equal(validateRisk({ ...safe, ...patch }).approved, false));
test("missing data fails closed", () =>
  assert.equal(validateRisk({}).approved, false));
test("stricter configured risk wins and minimum volume never expands the budget", () => {
  assert.equal(validateRisk({ ...safe, riskPerTrade: 0.002 }).volume, 0.02);
  const tiny = validateRisk({ ...safe, balance: 100, equity: 100 });
  assert.equal(tiny.approved, false);
  assert.ok(tiny.reasons.includes("Minimum lot exceeds risk budget"));
  const exact = validateRisk({ ...safe, existingRisk: 250 });
  assert.equal(exact.approved, true);
  assert.equal(exact.volume, 0.05);
});
