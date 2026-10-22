import { ApiError } from "./errors.mjs";
export const TIMEFRAMES = Object.freeze({
  M1: 60,
  M5: 300,
  M15: 900,
  H1: 3600,
});
const barFields = ["time", "open", "high", "low", "close", "volume"];

function closedBars(bars, seconds, brokerTimestamp, aligned = true) {
  if (!Array.isArray(bars) || bars.length < 50 || bars.length > 120)
    return false;
  let previous = 0;
  for (const b of bars) {
    if (
      !b ||
      !Number.isSafeInteger(b.time) ||
      b.time <= previous ||
      (aligned && b.time % seconds !== 0) ||
      ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
      [b.open, b.high, b.low, b.close].some((x) => x <= 0) ||
      b.low > Math.min(b.open, b.close) ||
      b.high < Math.max(b.open, b.close) ||
      b.high < b.low ||
      b.volume < 0
    )
      return false;
    previous = b.time;
  }
  const close = (previous + seconds) * 1000;
  return (
    Number.isSafeInteger(brokerTimestamp) &&
    close <= brokerTimestamp + 2000 &&
    brokerTimestamp - close <= seconds * 2000
  );
}

function sanitizeBars(bars) {
  return bars.map(({ time, open, high, low, close, volume }) => ({
    time,
    open,
    high,
    low,
    close,
    volume,
  }));
}

function frameProblem(s) {
  if (!s?.timeframes || typeof s.timeframes !== "object")
    return "M1, M5, M15 and H1 history is required from the connected terminal.";
  for (const [name, seconds] of Object.entries(TIMEFRAMES)) {
    if (!s.timeframes[name]) return `${name} closed candle history is missing.`;
    if (!closedBars(s.timeframes[name]?.bars, seconds, s.brokerTimestamp))
      return `${name} closed candle history is stale, incomplete or invalid.`;
  }
  const m5 = s.timeframes.M5.bars;
  if (
    !Array.isArray(s.bars) ||
    m5.length !== s.bars.length ||
    m5.some((b, i) => barFields.some((key) => b[key] !== s.bars[i]?.[key]))
  )
    return "M5 timeframe history does not match the verified root candles.";
  return null;
}

export function sanitizePositions(values) {
  if (!Array.isArray(values) || values.length > 100)
    throw new ApiError(
      422,
      "MT5 position data is invalid.",
      "MARKET_DATA_INVALID",
    );
  const tickets = new Set(),
    identifiers = new Set();
  return values.map((p) => {
    if (
      !p ||
      typeof p.symbol !== "string" ||
      !/^\S{1,40}$/.test(p.symbol) ||
      !["BUY", "SELL"].includes(p.side) ||
      ![p.volume, p.open, p.stop, p.takeProfit, p.profit].every(
        Number.isFinite,
      ) ||
      p.volume <= 0 ||
      p.open <= 0 ||
      p.stop < 0 ||
      p.takeProfit < 0
    )
      throw new ApiError(
        422,
        "MT5 position data is invalid.",
        "MARKET_DATA_INVALID",
      );
    const clean = {
      ...(typeof p.ticket === "string" &&
      /^\d{1,20}$/.test(p.ticket) &&
      typeof p.identifier === "string" &&
      /^\d{1,20}$/.test(p.identifier) &&
      Number.isSafeInteger(p.magic) &&
      p.magic >= 0 &&
      typeof p.comment === "string" &&
      p.comment.length <= 64
        ? {
            ticket: p.ticket,
            identifier: p.identifier,
            magic: p.magic,
            comment: p.comment,
            ownedIntegrity: p.ownedIntegrity === true,
          }
        : {}),
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      open: p.open,
      stop: p.stop,
      takeProfit: p.takeProfit,
      profit: p.profit,
    };
    if (clean.ticket) {
      if (tickets.has(clean.ticket) || identifiers.has(clean.identifier))
        throw new ApiError(422, "Duplicate broker position identity.");
      tickets.add(clean.ticket);
      identifiers.add(clean.identifier);
    }
    if (p.currentPrice !== undefined) {
      if (
        p.currentPrice !== null &&
        (!Number.isFinite(p.currentPrice) || p.currentPrice <= 0)
      )
        throw new ApiError(422, "Invalid broker position price.");
      clean.currentPrice = p.currentPrice;
    }
    if (p.openedAt !== undefined) {
      if (!Number.isSafeInteger(p.openedAt) || p.openedAt <= 0)
        throw new ApiError(422, "Invalid broker position opening time.");
      clean.openedAt = p.openedAt;
    }
    if (p.execution !== undefined) {
      const x = p.execution;
      if (
        !x ||
        !["timestamp", "brokerTimestamp", "quoteTimestamp"].every(
          (k) => Number.isSafeInteger(x[k]) && x[k] > 0,
        ) ||
        ![
          "bid",
          "ask",
          "point",
          "tickSize",
          "volumeStep",
          "minVolume",
          "maxVolume",
        ].every((k) => Number.isFinite(x[k]) && x[k] > 0) ||
        !["stopLevel", "freezeLevel"].every(
          (k) => Number.isFinite(x[k]) && x[k] >= 0,
        ) ||
        x.ask < x.bid ||
        typeof x.tradeAllowed !== "boolean"
      )
        throw new ApiError(422, "Invalid position symbol execution checks.");
      clean.execution = Object.fromEntries(
        [
          "timestamp",
          "brokerTimestamp",
          "quoteTimestamp",
          "bid",
          "ask",
          "point",
          "tickSize",
          "volumeStep",
          "minVolume",
          "maxVolume",
          "stopLevel",
          "freezeLevel",
          "tradeAllowed",
        ].map((k) => [k, x[k]]),
      );
      if (x.sessionOpen !== undefined) {
        if (typeof x.sessionOpen !== "boolean")
          throw new ApiError(422, "Invalid position broker session.");
        clean.execution.sessionOpen = x.sessionOpen;
      }
      for (const name of [
        "symbolTradeMode",
        "tradeExecutionMode",
        "orderMode",
        "fillingMode",
      ])
        if (x[name] !== undefined) {
          if (
            !Number.isSafeInteger(x[name]) ||
            x[name] < 0 ||
            x[name] > 2147483647
          )
            throw new ApiError(
              422,
              "Invalid position broker execution permissions.",
            );
          clean.execution[name] = x[name];
        }
    }
    return clean;
  });
}

// Snapshot age is checked by validateSnapshot at ingestion and before analysis.
// Here each frame is checked against that verified broker clock, not the PC clock.
export function requireMultiTimeframe(s) {
  const problem = frameProblem(s);
  if (problem) throw new ApiError(409, problem, "MULTI_TIMEFRAME_REQUIRED");
  return s;
}

export function decisionBar(s) {
  return s?.timeframes?.M1?.bars?.at(-1)?.time ?? s?.bars?.at(-1)?.time ?? null;
}

export function validateSnapshot(s, now = Date.now()) {
  if (
    !s ||
    typeof s !== "object" ||
    typeof s.symbol !== "string" ||
    !/^\S{1,40}$/.test(s.symbol) ||
    s.timeframe !== "M5" ||
    !Number.isFinite(s.timestamp) ||
    Math.abs(now - s.timestamp) > 30000 ||
    !Number.isSafeInteger(s.brokerTimestamp) ||
    !Number.isSafeInteger(s.quoteTimestamp) ||
    Math.abs(s.brokerTimestamp - s.timestamp) > 86400000 ||
    s.brokerTimestamp - s.quoteTimestamp > 15000 ||
    s.quoteTimestamp - s.brokerTimestamp > 2000 ||
    ![s.bid, s.ask, s.balance, s.equity].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    s.ask < s.bid ||
    typeof s.currency !== "string" ||
    !/^[A-Z]{3,8}$/.test(s.currency) ||
    !Array.isArray(s.bars) ||
    s.bars.length < 50 ||
    s.bars.length > 120 ||
    !Array.isArray(s.positions) ||
    s.positions.length > 100
  )
    throw new ApiError(
      422,
      "Fresh broker prices, account values, and at least 50 closed M5 candles are required.",
      "MARKET_DATA_INVALID",
    );
  let timeframes;
  if (s.timeframes !== undefined) {
    if (
      !s.timeframes ||
      typeof s.timeframes !== "object" ||
      Array.isArray(s.timeframes) ||
      Object.keys(s.timeframes).some((key) => !Object.hasOwn(TIMEFRAMES, key))
    )
      throw new ApiError(
        422,
        "MT5 timeframes are invalid.",
        "MARKET_DATA_INVALID",
      );
    timeframes = {};
    for (const [name, frame] of Object.entries(s.timeframes)) {
      if (!closedBars(frame?.bars, TIMEFRAMES[name], s.brokerTimestamp))
        throw new ApiError(
          422,
          `The ${name} closed candle history is invalid or stale.`,
          "MARKET_DATA_INVALID",
        );
      timeframes[name] = { bars: sanitizeBars(frame.bars) };
    }
    if (
      timeframes.M5 &&
      (timeframes.M5.bars.length !== s.bars.length ||
        timeframes.M5.bars.some((b, i) =>
          barFields.some((key) => b[key] !== s.bars[i]?.[key]),
        ))
    )
      throw new ApiError(
        422,
        "M5 timeframe history must match the root candles.",
        "MARKET_DATA_INVALID",
      );
  }
  let previous = 0;
  for (const b of s.bars) {
    if (
      !b ||
      !Number.isSafeInteger(b.time) ||
      b.time <= previous ||
      b.time > Math.floor(now / 1000) + 86400 ||
      ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
      [b.open, b.high, b.low, b.close].some((x) => x <= 0) ||
      b.low > Math.min(b.open, b.close) ||
      b.high < Math.max(b.open, b.close) ||
      b.high < b.low ||
      b.volume < 0
    )
      throw new ApiError(
        422,
        "MT5 candle data is invalid.",
        "MARKET_DATA_INVALID",
      );
    previous = b.time;
  }
  const lastClose = previous * 1000 + 300000;
  if (
    lastClose > s.brokerTimestamp + 2000 ||
    s.brokerTimestamp - lastClose > 600000
  )
    throw new ApiError(
      422,
      "The latest closed M5 candle is stale or incomplete.",
      "MARKET_DATA_INVALID",
    );
  const positions = sanitizePositions(s.positions);
  return {
    symbol: s.symbol,
    timeframe: s.timeframe,
    timestamp: s.timestamp,
    brokerTimestamp: s.brokerTimestamp,
    quoteTimestamp: s.quoteTimestamp,
    bid: s.bid,
    ask: s.ask,
    balance: s.balance,
    equity: s.equity,
    currency: s.currency,
    positions,
    bars: sanitizeBars(s.bars),
    ...(timeframes ? { timeframes } : {}),
  };
}
function emaSeries(values, period) {
  const alpha = 2 / (period + 1);
  let prior = values[0];
  return values.map(
    (v, i) => (prior = i ? v * alpha + prior * (1 - alpha) : v),
  );
}
function wilderSeries(values, period) {
  let average = 0,
    sum = 0;
  return values.map((value, i) => {
    if (i < period) {
      sum += value;
      if (i === period - 1) return (average = sum / period);
      return null;
    }
    average = (average * (period - 1) + value) / period;
    return average;
  });
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function technicals(s) {
  const closes = s.bars.map((b) => b.close);
  const ema9 = emaSeries(closes, 9).at(-1);
  const ema21 = emaSeries(closes, 21).at(-1);
  const ema50 = emaSeries(closes, 50).at(-1);
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macdValues = fast.map((v, i) => v - slow[i]);
  const macdLine = macdValues.at(-1);
  const macdSignal = emaSeries(macdValues, 9).at(-1);
  const changes = closes.slice(1).map((close, i) => close - closes[i]);
  const gain = wilderSeries(
    changes.map((v) => Math.max(v, 0)),
    14,
  ).at(-1);
  const loss = wilderSeries(
    changes.map((v) => Math.max(-v, 0)),
    14,
  ).at(-1);
  const rsi14 =
    loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  let weighted = 0,
    volume = 0;
  for (const b of s.bars) {
    weighted += ((b.high + b.low + b.close) / 3) * b.volume;
    volume += b.volume;
  }
  const trueRanges = s.bars.map((b, i) => {
    const prev = s.bars[i - 1]?.close ?? b.open;
    return Math.max(
      b.high - b.low,
      Math.abs(b.high - prev),
      Math.abs(b.low - prev),
    );
  });
  const atrValues = wilderSeries(trueRanges, 14);
  const atr14 = atrValues.at(-1);
  const atrBaseline = median(atrValues.slice(-21, -1));
  const volatilityRatio =
    atrBaseline > 0 ? atr14 / atrBaseline : atr14 > 0 ? Infinity : 0;
  const volatilityRegime =
    volatilityRatio >= 2.5
      ? "extreme"
      : volatilityRatio >= 1.5
        ? "high"
        : volatilityRatio < 0.7
          ? "low"
          : "normal";
  const previous = s.bars.slice(-11, -1);
  const supportWindow = s.bars.slice(-21, -1);
  const last = s.bars.at(-1);
  const high = Math.max(...previous.map((b) => b.high)),
    low = Math.min(...previous.map((b) => b.low));
  const separation = atr14 > 0 ? Math.abs(ema21 - ema50) / atr14 : 0;
  const direction =
    separation >= 0.1 && last.close > ema21 && ema9 > ema21 && ema21 > ema50
      ? "up"
      : separation >= 0.1 && last.close < ema21 && ema9 < ema21 && ema21 < ema50
        ? "down"
        : "range";
  return {
    ema9,
    ema21,
    ema50,
    rsi14,
    macd: {
      line: macdLine,
      signal: macdSignal,
      histogram: macdLine - macdSignal,
      signalMethod: "EMA9",
    },
    atr14,
    support: Math.min(...supportWindow.map((b) => b.low)),
    resistance: Math.max(...supportWindow.map((b) => b.high)),
    trend: { direction, strength: Math.min(1, separation / 2) },
    volatilityRatio,
    volatility: {
      ratio: volatilityRatio,
      regime: volatilityRegime,
      baselineAtr14: atrBaseline,
    },
    windowVwap: volume ? weighted / volume : null,
    priorHigh: high,
    priorLow: low,
    bullishSweep: last.low < low && last.close > low,
    bearishSweep: last.high > high && last.close < high,
    spread: s.ask - s.bid,
  };
}

export function adaptiveProfile(s, settings = {}) {
  const mode =
    settings.tradingMode === "aggressive" ? "aggressive" : "balanced";
  const configuredRisk = Number.isFinite(settings.riskPerTradePct)
    ? Math.max(0, settings.riskPerTradePct)
    : 0.5;
  const minConfidence = Math.max(
    mode === "balanced" ? 0.8 : 0.75,
    Number.isFinite(settings.minConfidence)
      ? Math.min(1, Math.max(0, settings.minConfidence))
      : 0,
  );
  const base = {
    ready: false,
    mode,
    regime: "unavailable",
    effectiveRiskPct: 0,
    minConfidence,
    minRewardRisk: mode === "balanced" ? 1.5 : 1.2,
    scalpingEligible: false,
    scalpingSide: null,
    scalpingReason: "Complete, fresh M1, M5, M15 and H1 candles are required.",
    allowedStrategies: ["wait"],
    decisionTimeframe: "M1",
    decisionBarTime: decisionBar(s),
    frames: {},
  };
  const problem = frameProblem(s);
  if (problem) return { ...base, reason: problem, scalpingReason: problem };
  const frames = Object.fromEntries(
    Object.keys(TIMEFRAMES).map((name) => [
      name,
      {
        ...technicals({
          bars: s.timeframes[name].bars,
          bid: s.bid,
          ask: s.ask,
        }),
        barTime: s.timeframes[name].bars.at(-1).time,
        barCount: s.timeframes[name].bars.length,
      },
    ]),
  );
  const values = Object.values(frames);
  if (
    values.some(
      (f) =>
        ![f.atr14, f.rsi14, f.ema50, f.macd.line, f.volatilityRatio].every(
          Number.isFinite,
        ),
    )
  )
    return {
      ...base,
      reason:
        "Market indicators cannot be safely calculated from this history.",
    };
  const extreme = values.some((f) => f.volatility.regime === "extreme");
  const inactive = values.some((f) => f.atr14 <= 0);
  const high = values.some((f) => f.volatility.regime === "high");
  const low = values.some((f) => f.volatility.regime === "low");
  const direction = frames.M5.trend.direction;
  const aligned =
    direction !== "range" &&
    [frames.M15, frames.H1].every((f) => f.trend.direction === direction);
  const range = direction === "range";
  const regime = extreme
    ? "extreme-volatility"
    : inactive
      ? "inactive"
      : high
        ? "high-volatility"
        : aligned
          ? "trend"
          : range
            ? "range"
            : "mixed";
  const m1 = frames.M1;
  const momentumAgrees = (frame) =>
    direction === "up"
      ? frame.macd.line > 0 && frame.macd.histogram >= 0 && frame.rsi14 > 50
      : direction === "down" &&
        frame.macd.line < 0 &&
        frame.macd.histogram <= 0 &&
        frame.rsi14 < 50;
  const sameTrend = direction !== "range" && m1.trend.direction === direction;
  const affordable =
    (s.ask - s.bid) / m1.atr14 <= (mode === "balanced" ? 0.08 : 0.12);
  const scalpingEligible =
    !extreme &&
    !inactive &&
    sameTrend &&
    momentumAgrees(m1) &&
    momentumAgrees(frames.M5) &&
    affordable;
  const scalpingReason = extreme
    ? "Extreme volatility blocks scalping."
    : inactive
      ? "There is no measurable current price volatility."
      : !sameTrend
        ? "M1 and M5 trends do not agree."
        : !momentumAgrees(m1) || !momentumAgrees(frames.M5)
          ? "M1 and M5 momentum do not confirm the trend."
          : !affordable
            ? "Spread is too large relative to M1 ATR."
            : "M1 and M5 trend and momentum agree, and spread is within the mode's ATR limit.";
  let effectiveRiskPct = Math.min(configuredRisk, 0.5);
  if (high) effectiveRiskPct *= 0.5;
  if (range || !aligned) effectiveRiskPct *= 0.5;
  if (low) effectiveRiskPct *= 0.75;
  if (extreme || inactive) effectiveRiskPct = 0;
  const allowedStrategies = [];
  if (effectiveRiskPct > 0) {
    if (aligned) allowedStrategies.push("trend");
    if (
      range &&
      (m1.rsi14 <= 30 || m1.rsi14 >= 70 || m1.bullishSweep || m1.bearishSweep)
    )
      allowedStrategies.push("reversal");
    if (scalpingEligible) allowedStrategies.push("scalping");
  }
  allowedStrategies.push("wait");
  return {
    ...base,
    ready: true,
    regime,
    effectiveRiskPct,
    scalpingEligible,
    scalpingSide: scalpingEligible
      ? direction === "up"
        ? "BUY"
        : "SELL"
      : null,
    scalpingReason,
    allowedStrategies,
    frames,
    reason: extreme
      ? "Extreme volatility blocks new entries."
      : inactive
        ? "Inactive prices block new entries."
        : "Risk and strategy permissions are calculated from the verified terminal history.",
  };
}
