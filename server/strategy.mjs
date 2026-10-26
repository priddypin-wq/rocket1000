import { adaptiveProfile, technicals } from "./market.mjs";

function validClosedCandles(bars) {
  return (
    Array.isArray(bars) &&
    bars.length >= 25 &&
    bars.every(
      (b, i) =>
        b &&
        [b.open, b.high, b.low, b.close, b.time].every(Number.isFinite) &&
        [b.open, b.high, b.low, b.close, b.time].every((n) => n > 0) &&
        b.high >= Math.max(b.open, b.close) &&
        b.low <= Math.min(b.open, b.close) &&
        (i === 0 || b.time > bars[i - 1].time),
    )
  );
}

// Observations from actual closed broker candles; these are neither forecasts
// nor instructions to the execution engine. No charts are needed to compute them.
export function priceActionFeatures(bars) {
  if (!validClosedCandles(bars)) return null;
  const last = bars.at(-1),
    prev = bars.at(-2);
  const prior = bars.slice(-22, -2);
  const resistance = Math.max(...prior.map((b) => b.high));
  const support = Math.min(...prior.map((b) => b.low));
  const swings = [];
  for (let i = Math.max(2, bars.length - 50); i < bars.length - 2; i++) {
    const b = bars[i],
      left = bars.slice(i - 2, i),
      right = bars.slice(i + 1, i + 3);
    if ([...left, ...right].every((p) => b.high > p.high))
      swings.push({ type: "high", price: b.high, time: b.time });
    if ([...left, ...right].every((p) => b.low < p.low))
      swings.push({ type: "low", price: b.low, time: b.time });
  }
  const highs = swings.filter((p) => p.type === "high").slice(-2);
  const lows = swings.filter((p) => p.type === "low").slice(-2);
  const structure =
    highs.length === 2 && lows.length === 2
      ? highs[1].price > highs[0].price && lows[1].price > lows[0].price
        ? "higher-highs-higher-lows"
        : highs[1].price < highs[0].price && lows[1].price < lows[0].price
          ? "lower-highs-lower-lows"
          : "mixed"
      : "insufficient-confirmed-swings";
  const range = last.high - last.low,
    body = Math.abs(last.close - last.open);
  return {
    barTime: last.time,
    support,
    resistance,
    structure,
    swings: swings.slice(-8),
    breakout:
      last.close > resistance
        ? "above-resistance"
        : last.close < support
          ? "below-support"
          : null,
    retest:
      prev.close > resistance &&
      last.low <= resistance &&
      last.close > resistance
        ? "resistance-held-as-support"
        : prev.close < support && last.high >= support && last.close < support
          ? "support-held-as-resistance"
          : null,
    candle: {
      direction:
        last.close > last.open
          ? "bullish"
          : last.close < last.open
            ? "bearish"
            : "neutral",
      bullishEngulfing:
        prev.close < prev.open &&
        last.close > last.open &&
        last.open <= prev.close &&
        last.close >= prev.open,
      bearishEngulfing:
        prev.close > prev.open &&
        last.close < last.open &&
        last.open >= prev.close &&
        last.close <= prev.open,
      bullishRejection:
        range > 0 &&
        Math.min(last.open, last.close) - last.low >=
          2 * Math.max(body, range * 0.05) &&
        last.close >= last.low + range * 0.65,
      bearishRejection:
        range > 0 &&
        last.high - Math.max(last.open, last.close) >=
          2 * Math.max(body, range * 0.05) &&
        last.close <= last.low + range * 0.35,
    },
  };
}

// SMC/ICT names describe reproducible candle geometry, not exchange order-book
// liquidity or a statistically validated edge. Only prior closed bars are used
// to form a zone; subsequent closed bars describe its observed mitigation.
export function smartMoneyFeatures(bars) {
  if (!validClosedCandles(bars)) return null;
  const sweeps = [],
    fairValueGaps = [],
    orderBlocks = [];
  const from = Math.max(2, bars.length - 60);
  for (let i = from; i < bars.length; i++) {
    const candle = bars[i],
      first = bars[i - 2],
      after = bars.slice(i + 1);
    const gap =
      candle.low > first.high
        ? { side: "bullish", lower: first.high, upper: candle.low }
        : candle.high < first.low
          ? { side: "bearish", lower: candle.high, upper: first.low }
          : null;
    if (gap) {
      const entered = after.some((b) =>
        gap.side === "bullish" ? b.low < gap.upper : b.high > gap.lower,
      );
      const filled = after.some((b) =>
        gap.side === "bullish" ? b.low <= gap.lower : b.high >= gap.upper,
      );
      fairValueGaps.push({
        ...gap,
        formedAt: candle.time,
        status: filled ? "filled" : entered ? "partially-filled" : "unfilled",
      });
    }
    if (i >= 20) {
      const before = bars.slice(i - 20, i),
        high = Math.max(...before.map((b) => b.high)),
        low = Math.min(...before.map((b) => b.low));
      if (candle.high > high && candle.close < high)
        sweeps.push({
          side: "buy-side",
          referenceLevel: high,
          extreme: candle.high,
          close: candle.close,
          time: candle.time,
        });
      if (candle.low < low && candle.close > low)
        sweeps.push({
          side: "sell-side",
          referenceLevel: low,
          extreme: candle.low,
          close: candle.close,
          time: candle.time,
        });
    }
    if (i < 10) continue;
    const before = bars.slice(i - 10, i),
      ranges = before.map((b) => b.high - b.low).sort((a, b) => a - b),
      typicalRange = (ranges[4] + ranges[5]) / 2,
      body = Math.abs(candle.close - candle.open),
      range = candle.high - candle.low;
    if (
      typicalRange <= 0 ||
      body < typicalRange * 1.5 ||
      range <= 0 ||
      body / range < 0.6
    )
      continue;
    const breakoutRange = before.slice(-5),
      bullish = candle.close > candle.open,
      brokeRange = bullish
        ? candle.close > Math.max(...breakoutRange.map((b) => b.high))
        : candle.close < Math.min(...breakoutRange.map((b) => b.low));
    if (!brokeRange) continue;
    const origin = bars
      .slice(Math.max(0, i - 5), i)
      .reverse()
      .find((b) => (bullish ? b.close < b.open : b.close > b.open));
    if (!origin) continue;
    const invalidated = after.some((b) =>
      bullish ? b.close < origin.low : b.close > origin.high,
    );
    const revisited = after.some(
      (b) => b.low <= origin.high && b.high >= origin.low,
    );
    // One origin may precede several displacement candles. Preserve the first
    // confirmation so later candles cannot rewrite when the pattern formed.
    if (orderBlocks.some((b) => b.originTime === origin.time)) continue;
    orderBlocks.push({
      side: bullish ? "bullish" : "bearish",
      lower: origin.low,
      upper: origin.high,
      originTime: origin.time,
      confirmedAt: candle.time,
      status: invalidated
        ? "invalidated"
        : revisited
          ? "revisited"
          : "untested",
    });
  }
  const pa = priceActionFeatures(bars);
  return {
    method: "closed-candle-geometric-heuristics",
    statisticallyValidated: false,
    observedFrom: bars[0].time,
    observedThrough: bars.at(-1).time,
    liquiditySweeps: sweeps.slice(-8),
    fairValueGaps: fairValueGaps.slice(-8),
    orderBlocks: orderBlocks.slice(-6),
    trendStructure: pa.structure,
    reversalPatterns: Object.entries(pa.candle)
      .filter(([name, value]) => name !== "direction" && value === true)
      .map(([name]) => name),
  };
}

export function selectedStrategyProfile(
  snapshot,
  settings = {},
  profile = adaptiveProfile(snapshot, settings),
  execution = null,
) {
  const strategy = settings.strategy || "adaptive";
  const scalpSession =
    !execution ||
    (execution.sessionOpen === true &&
      execution.tradeAllowed === true &&
      [1, 2, 4].includes(execution.symbolTradeMode) &&
      [0, 1, 2, 3].includes(execution.tradeExecutionMode) &&
      Number.isInteger(execution.orderMode) &&
      (execution.orderMode & 1) === 1);
  const scalpingEligible = profile.scalpingEligible && scalpSession;
  const breakoutFrame = snapshot.timeframes?.M1?.bars;
  const breakoutAction = priceActionFeatures(breakoutFrame);
  const breakoutSide =
    breakoutAction?.retest === "resistance-held-as-support"
      ? "BUY"
      : breakoutAction?.retest === "support-held-as-resistance"
        ? "SELL"
        : null;
  const breakoutEligible =
    scalpSession &&
    profile.ready &&
    profile.effectiveRiskPct > 0 &&
    profile.regime !== "extreme-volatility" &&
    breakoutSide !== null &&
    [profile.frames?.M5, profile.frames?.M15].every(
      (f) => f?.trend?.direction === (breakoutSide === "BUY" ? "up" : "down"),
    );
  const last = breakoutFrame?.at(-1),
    prior = breakoutFrame?.at(-2);
  const previousAction = Array.isArray(breakoutFrame)
    ? priceActionFeatures(breakoutFrame.slice(0, -1))
    : null;
  const precedingTrend =
    breakoutFrame?.length >= 27
      ? technicals({
          bars: breakoutFrame.slice(0, -2),
          bid: snapshot.bid,
          ask: snapshot.ask,
        }).trend.direction
      : null;
  // A completed rejection/sweep needs a later completed directional candle.
  // Temporary floating loss and a model's opinion cannot manufacture this gate.
  const previousRange = Array.isArray(breakoutFrame)
    ? breakoutFrame.slice(-22, -2)
    : [];
  const sweptLow =
    previousRange.length >= 20 &&
    prior.low < Math.min(...previousRange.map((b) => b.low)) &&
    prior.close > Math.min(...previousRange.map((b) => b.low));
  const sweptHigh =
    previousRange.length >= 20 &&
    prior.high > Math.max(...previousRange.map((b) => b.high)) &&
    prior.close < Math.max(...previousRange.map((b) => b.high));
  const reversalSide =
    last &&
    prior &&
    last.close > last.open &&
    last.close > prior.high &&
    (sweptLow ||
      (precedingTrend === "down" && previousAction?.candle.bullishRejection))
      ? "BUY"
      : last &&
          prior &&
          last.close < last.open &&
          last.close < prior.low &&
          (sweptHigh ||
            (precedingTrend === "up" &&
              previousAction?.candle.bearishRejection))
        ? "SELL"
        : null;
  const reversalEligible =
    scalpSession &&
    profile.ready &&
    profile.effectiveRiskPct > 0 &&
    profile.regime !== "extreme-volatility" &&
    reversalSide !== null;
  const allowedStrategies = profile.allowedStrategies.filter(
    (name) =>
      name === "wait" ||
      (name === "scalping"
        ? strategy !== "price-action" && scalpingEligible
        : name === "reversal"
          ? strategy !== "scalping" && reversalEligible
          : strategy !== "scalping"),
  );
  if (strategy !== "scalping" && breakoutEligible)
    allowedStrategies.splice(allowedStrategies.indexOf("wait"), 0, "breakout");
  if (
    strategy !== "scalping" &&
    reversalEligible &&
    !allowedStrategies.includes("reversal")
  )
    allowedStrategies.splice(allowedStrategies.indexOf("wait"), 0, "reversal");
  const slippagePoints = Number.isFinite(settings.maxSlippagePoints)
    ? Math.max(0, Math.min(10, settings.maxSlippagePoints))
    : 10;
  const costDataReady =
    execution?.costsVerified === true &&
    Number.isFinite(execution.commissionPerLot) &&
    execution.commissionPerLot >= 0 &&
    [execution.tickSize, execution.tickValue, execution.point].every(
      (n) => Number.isFinite(n) && n > 0,
    );
  const totalCostDistance = costDataReady
    ? snapshot.ask -
      snapshot.bid +
      (execution.commissionPerLot * execution.tickSize) / execution.tickValue +
      2 * slippagePoints * execution.point
    : null;
  return {
    ...profile,
    selectedStrategy: strategy,
    scalpingEligible,
    breakoutEligible,
    breakoutSide: breakoutEligible ? breakoutSide : null,
    trendSide:
      profile.frames?.M5?.trend?.direction === "up"
        ? "BUY"
        : profile.frames?.M5?.trend?.direction === "down"
          ? "SELL"
          : null,
    reversalEligible,
    reversalSide: reversalEligible ? reversalSide : null,
    reversalReason: reversalEligible
      ? "A completed rejection or liquidity sweep is followed by a completed directional confirmation."
      : "A completed sweep/rejection and subsequent confirmation are required.",
    breakoutReason: breakoutEligible
      ? "A completed M1 breakout/retest agrees with verified M5 and M15 trend direction."
      : "A completed breakout/retest with higher-timeframe confirmation is required.",
    totalCostDistance,
    scalpingReason: !scalpSession
      ? "Verified broker session and execution permissions are required for scalping."
      : profile.scalpingReason,
    allowedStrategies,
  };
}

export function strategyContext(snapshot, execution = {}) {
  const frames = Object.entries(snapshot.timeframes || {});
  const priceAction = Object.fromEntries(
    frames.map(([name, frame]) => [name, priceActionFeatures(frame.bars)]),
  );
  return {
    priceAction,
    smartMoney: Object.fromEntries(
      frames.map(([name, frame]) => [name, smartMoneyFeatures(frame.bars)]),
    ),
    observedRewardRisk: Object.fromEntries(
      Object.entries(priceAction).map(([name, levels]) => {
        const buyRisk = levels ? snapshot.ask - levels.support : 0,
          buyReward = levels ? levels.resistance - snapshot.ask : 0,
          sellRisk = levels ? levels.resistance - snapshot.bid : 0,
          sellReward = levels ? snapshot.bid - levels.support : 0;
        return [
          name,
          {
            method: "distance-to-observed-range-boundaries",
            buy: buyRisk > 0 && buyReward > 0 ? buyReward / buyRisk : null,
            sell: sellRisk > 0 && sellReward > 0 ? sellReward / sellRisk : null,
          },
        ];
      }),
    ),
    economicNews: { connected: false, events: null },
    tradeProbability: {
      statisticallyValidated: false,
      value: null,
      reason:
        "No out-of-sample calibrated trade-probability model is connected.",
    },
    brokerConditions: {
      costsVerified: execution.costsVerified === true,
      roundtripCommissionPerLot: Number.isFinite(execution.commissionPerLot)
        ? execution.commissionPerLot
        : null,
      stopLevel: Number.isFinite(execution.stopLevel)
        ? execution.stopLevel
        : null,
      freezeLevel: Number.isFinite(execution.freezeLevel)
        ? execution.freezeLevel
        : null,
      sessionOpen:
        typeof execution.sessionOpen === "boolean"
          ? execution.sessionOpen
          : null,
      tradeAllowed:
        typeof execution.tradeAllowed === "boolean"
          ? execution.tradeAllowed
          : null,
      symbolTradeMode: Number.isInteger(execution.symbolTradeMode)
        ? execution.symbolTradeMode
        : null,
      executionMode: Number.isInteger(execution.tradeExecutionMode)
        ? execution.tradeExecutionMode
        : null,
      brokerTimestamp: snapshot.brokerTimestamp,
      spread: snapshot.ask - snapshot.bid,
    },
  };
}
