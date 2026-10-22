import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptiveProfile, TIMEFRAMES } from "../server/market.mjs";
import { validateAssessment } from "../server/ai-analysis.mjs";
import { orderRisk } from "../server/trading.mjs";
import { defaultTradeSettings } from "../server/trade-settings.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// Numerical fixtures only: these checks never contact a model or broker.
const NOW = 1800000000000;
function snapshot(direction) {
  const timeframes = Object.fromEntries(
    Object.entries(TIMEFRAMES).map(([name, seconds]) => [
      name,
      {
        bars: Array.from({ length: 100 }, (_, i) => {
          const close = direction === "up" ? 100 + i : 300 - i;
          return {
            time:
              Math.floor(NOW / (seconds * 1000)) * seconds -
              (100 - i) * seconds,
            open: close - 0.25,
            high: close + 1,
            low: close - 1,
            close,
            volume: 100 + i,
          };
        }),
      },
    ]),
  );
  const bid = direction === "up" ? 199 : 201;
  return {
    symbol: "XAUUSD",
    timeframe: "M5",
    timestamp: NOW,
    brokerTimestamp: NOW,
    quoteTimestamp: NOW,
    bid,
    ask: bid + 0.1,
    balance: 10000,
    equity: 10000,
    currency: "USD",
    positions: [],
    bars: structuredClone(timeframes.M5.bars),
    timeframes,
  };
}
function signal(market, side) {
  const buy = side === "BUY";
  const entryPrice = buy ? market.ask : market.bid;
  return {
    decision: side,
    confidence: 0.95,
    strategy: "scalping",
    timeframe: "M1",
    entryPrice,
    stopLoss: entryPrice + (buy ? -5 : 5),
    takeProfit: entryPrice + (buy ? 10 : -10),
    reasoning: "Deterministic direction-guard fixture only.",
    risks: [],
  };
}
function context(market, profile, tradingMode) {
  return {
    market,
    profile,
    now: NOW,
    settings: { ...defaultTradeSettings, tradingMode, sizingMode: "adaptive" },
    revision: "fixture-revision",
    i: { account_type: "demo" },
    enabled: true,
    blockers: [],
    execution: {
      sessionOpen: true,
      tradeAllowed: true,
      symbolTradeMode: 4,
      tradeExecutionMode: 2,
      orderMode: 49,
      protocol: 4,
      tickSize: 0.01,
      tickValue: 1,
      point: 0.01,
      volumeStep: 0.01,
      minVolume: 0.01,
      maxVolume: 10,
      stopLevel: 10,
      dayStartEquity: 10000,
      dailyLoss: 0,
      peakEquity: 10000,
      existingRisk: 0,
      newsVerified: true,
      newsBlocked: false,
      stopsVerified: true,
    },
  };
}
function order(assessment, profile) {
  return {
    kind: "OPEN",
    side: assessment.decision,
    symbol: "XAUUSD",
    stop: assessment.stopLoss,
    takeProfit: assessment.takeProfit,
    maxLots: 10,
    source: "ai",
    engineVersion: ENGINE_VERSION,
    signalExpiresAt: NOW + 60000,
    signalBarTime: profile.decisionBarTime,
    signalStrategy: "scalping",
    signalConfidence: assessment.confidence,
  };
}

for (const tradingMode of ["balanced", "aggressive"]) {
  for (const [direction, side, contrary] of [
    ["up", "BUY", "SELL"],
    ["down", "SELL", "BUY"],
  ]) {
    test(`${tradingMode} ${direction} scalp accepts ${side} and rejects contrary ${contrary} at analysis and order approval`, () => {
      const market = snapshot(direction);
      const profile = adaptiveProfile(market, { tradingMode });
      assert.equal(profile.scalpingEligible, true);
      assert.equal(profile.frames.M1.trend.direction, direction);
      assert.equal(profile.frames.M5.trend.direction, direction);
      assert.equal(profile.scalpingSide, side);
      const accepted = signal(market, side);
      assert.equal(validateAssessment(accepted, market, profile), accepted);
      assert.throws(
        () => validateAssessment(signal(market, contrary), market, profile),
        (e) => e.code === "AI_INVALID_RESPONSE",
      );
      const ctx = context(market, profile, tradingMode);
      const approved = orderRisk(ctx, order(accepted, profile));
      assert.ok(approved.volume > 0);
      assert.ok(
        approved.riskAmount <= (10000 * profile.effectiveRiskPct) / 100 + 1e-8,
      );
      assert.throws(
        () => orderRisk(ctx, order(signal(market, contrary), profile)),
        (e) => e.status === 409 && /trend direction/.test(e.message),
      );
      // Rechecking the current profile rejects a once-valid side if momentum
      // reverses before authorization, even while this command remains fresh.
      const changed = adaptiveProfile(
        snapshot(direction === "up" ? "down" : "up"),
        { tradingMode },
      );
      assert.throws(
        () => orderRisk({ ...ctx, profile: changed }, order(accepted, profile)),
        (e) => e.status === 409 && /trend direction/.test(e.message),
      );
    });
  }
}
