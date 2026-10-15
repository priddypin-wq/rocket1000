// Fail-closed validation and deterministic, non-AI trading gates.
export const POLICY = Object.freeze({
  timeframe: "M15",
  timeframeSeconds: 900,
  minCandles: 35,
  maxCandles: 64,
  maxSpreadPoints: 20,
  maxDailyLossPercent: 1,
  maxOpenPositions: 0, // no new signal while any position is open
  minConfidence: 0.75,
  minAtrPoints: 5
});

export function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateSnapshot(s, allowedSymbol, now = Math.floor(Date.now() / 1000)) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "Invalid snapshot";
  if (s.accountMode !== "DEMO") return "DEMO accounts only";
  if (!Number.isSafeInteger(s.accountLogin) || s.accountLogin <= 0) return "Invalid account login";
  if (s.symbol !== allowedSymbol || !/^[A-Za-z0-9._-]{1,24}$/.test(s.symbol)) return "Symbol not allowed";
  if (s.timeframe !== POLICY.timeframe) return "M15 closed candles required";
  if (![s.balance, s.equity, s.bid, s.ask, s.point, s.spreadPoints].every(safeNumber)) return "Non-finite market/account values";
  if (s.balance <= 0 || s.equity <= 0 || s.bid <= 0 || s.ask <= s.bid || s.point <= 0) return "Invalid market/account values";
  if (s.spreadPoints < 0 || s.spreadPoints > POLICY.maxSpreadPoints) return "Spread limit";
  if (Math.abs((s.ask - s.bid) / s.point - s.spreadPoints) > 2) return "Inconsistent spread";
  if (!Number.isSafeInteger(s.openPositions) || s.openPositions < 0 || s.openPositions > POLICY.maxOpenPositions) return "Existing open positions";
  if (!Number.isSafeInteger(s.pendingOrders) || s.pendingOrders !== 0) return "Pending orders exist";
  if (!Array.isArray(s.candles) || s.candles.length < POLICY.minCandles || s.candles.length > POLICY.maxCandles) return "Insufficient candles";
  let previous = 0;
  for (const c of s.candles) {
    if (!Number.isSafeInteger(c.time) || ![c.open, c.high, c.low, c.close].every(safeNumber)) return "Invalid candle";
    if (c.time <= previous || (previous && c.time - previous !== POLICY.timeframeSeconds)) return "Non-consecutive candles";
    if (c.low <= 0 || c.high < c.low || c.open < c.low || c.open > c.high || c.close < c.low || c.close > c.high) return "Malformed OHLC";
    previous = c.time;
  }
  const age = now - previous; // last candle OPEN time, not close time
  if (age < POLICY.timeframeSeconds || age > POLICY.timeframeSeconds * 2 + 120) return "Stale or unclosed market data";
  return null;
}

export function ema(prices, period) {
  if (!Array.isArray(prices) || prices.length < period) throw new Error("Not enough EMA prices");
  let result = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < prices.length; i++) result = prices[i] * alpha + result * (1 - alpha);
  return result;
}

export function atr(candles, period = 14) {
  if (candles.length < period + 1) throw new Error("Not enough ATR candles");
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], prevClose = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  return sum / period;
}

export function marketFeatures(snapshot) {
  const closes = snapshot.candles.map(c => c.close);
  return {
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    atr14: atr(snapshot.candles),
    lastClose: closes[closes.length - 1],
    barTime: snapshot.candles[snapshot.candles.length - 1].time
  };
}

export function deterministicGate(snapshot, features, action, confidence) {
  if (!["BUY", "SELL"].includes(action)) return "AI chose WAIT";
  if (!safeNumber(confidence) || confidence < POLICY.minConfidence || confidence > 1) return "Low/invalid AI confidence";
  if (features.atr14 < POLICY.minAtrPoints * snapshot.point) return "Volatility below minimum";
  if (action === "BUY" && !(features.lastClose > features.ema9 && features.ema9 > features.ema21)) return "BUY not aligned with trend";
  if (action === "SELL" && !(features.lastClose < features.ema9 && features.ema9 < features.ema21)) return "SELL not aligned with trend";
  return null;
}

export function dailyLossGate(currentEquity, startEquity) {
  if (!safeNumber(startEquity) || startEquity <= 0 || !safeNumber(currentEquity) || currentEquity <= 0) return "Equity missing";
  return currentEquity <= startEquity * (1 - POLICY.maxDailyLossPercent / 100)
    ? "Maximum daily equity drawdown reached" : null;
}
