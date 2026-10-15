import test from "node:test";
import assert from "node:assert/strict";
import { validateSnapshot, marketFeatures, deterministicGate, dailyLossGate } from "../src/risk.mjs";

function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const lastOpen = Math.floor(now / 900) * 900 - 900;
  const candles = Array.from({ length: 40 }, (_, i) => {
    const close = 1.1 + i * 0.0002;
    return {
      time: lastOpen - (39 - i) * 900, open: close - 0.0001,
      high: close + 0.0003, low: close - 0.0003, close
    };
  });
  return {
    accountMode: "DEMO", accountLogin: 123456,
    symbol: "EURUSD", timeframe: "M15", balance: 10000, equity: 10000,
    bid: 1.1077, ask: 1.10782, point: 0.00001, spreadPoints: 12,
    openPositions: 0, pendingOrders: 0, marketServerTime: now, candles
  };
}

test("accepts valid demo closed-bar snapshot", () => {
  assert.equal(validateSnapshot(fixture(), "EURUSD"), null);
});

test("rejects LIVE accounts even if candles are good", () => {
  const s = fixture(); s.accountMode = "LIVE";
  assert.match(validateSnapshot(s, "EURUSD"), /DEMO/);
});

test("blocks wide spreads, positions and pending orders", () => {
  const s = fixture(); s.spreadPoints = 30;
  assert.match(validateSnapshot(s, "EURUSD"), /Spread/);
  s.spreadPoints = 12; s.openPositions = 1;
  assert.match(validateSnapshot(s, "EURUSD"), /positions/);
  s.openPositions = 0; s.pendingOrders = 1;
  assert.match(validateSnapshot(s, "EURUSD"), /Pending/);
});

test("rejects future, stale, malformed and non-consecutive candles", () => {
  const future = fixture(); future.marketServerTime = future.candles.at(-1).time + 100;
  assert.match(validateSnapshot(future, "EURUSD"), /Stale/);
  const gap = fixture(); gap.candles[20].time += 30;
  assert.match(validateSnapshot(gap, "EURUSD"), /Non-consecutive/);
  const corrupt = fixture(); corrupt.candles[10].high = 0;
  assert.match(validateSnapshot(corrupt, "EURUSD"), /Malformed/);
});

test("trend gate only accepts aligned directions with high confidence", () => {
  const s = fixture(), f = marketFeatures(s);
  assert.ok(f.ema9 > f.ema21);
  assert.equal(deterministicGate(s, f, "BUY", 0.9), null);
  assert.match(deterministicGate(s, f, "SELL", 0.9), /trend/);
  assert.match(deterministicGate(s, f, "BUY", 0.1), /confidence/);
});

test("daily equity drawdown blocks at one percent", () => {
  assert.equal(dailyLossGate(9950, 10000), null);
  assert.match(dailyLossGate(9900, 10000), /drawdown/);
});
