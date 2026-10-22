// Pure validation: approval here never authorizes execution by itself.
export function validateRisk(s) {
  const perTrade = s?.riskPerTrade ?? 0.005,
    dailyLimit = s?.dailyLossLimit ?? 0.05,
    aggregateLimit = s?.aggregateLimit ?? 0.03,
    positionLimit = s?.positionLimit ?? 3;
  if (
    ![perTrade, dailyLimit, aggregateLimit, positionLimit].every(
      Number.isFinite,
    ) ||
    perTrade <= 0 ||
    perTrade > 0.005 ||
    dailyLimit <= 0 ||
    dailyLimit > 0.05 ||
    aggregateLimit <= 0 ||
    aggregateLimit > 0.03 ||
    !Number.isInteger(positionLimit) ||
    positionLimit < 1 ||
    positionLimit > 3
  )
    return { approved: false, reasons: ["Invalid risk limits"], volume: 0 };
  const numbers = [
    "balance",
    "equity",
    "dayStartEquity",
    "dailyLoss",
    "openPositions",
    "entry",
    "stop",
    "tickSize",
    "tickValue",
    "volumeStep",
    "minVolume",
    "maxVolume",
    "spread",
    "maxSpread",
    "slippage",
    "maxSlippage",
    "existingRisk",
    "peakEquity",
    "maxDrawdown",
  ];
  const reasons = [];
  if (!s || numbers.some((k) => !Number.isFinite(s[k])))
    return {
      approved: false,
      reasons: ["Incomplete or non-finite broker/risk data"],
      volume: 0,
    };
  if (
    [
      "balance",
      "equity",
      "dayStartEquity",
      "entry",
      "stop",
      "tickSize",
      "tickValue",
      "volumeStep",
      "minVolume",
      "maxVolume",
      "peakEquity",
    ].some((k) => s[k] <= 0) ||
    [
      "dailyLoss",
      "openPositions",
      "spread",
      "maxSpread",
      "slippage",
      "maxSlippage",
      "existingRisk",
    ].some((k) => s[k] < 0) ||
    !Number.isInteger(s.openPositions) ||
    s.maxVolume < s.minVolume ||
    s.maxDrawdown <= 0 ||
    s.maxDrawdown > 0.05
  )
    return {
      approved: false,
      reasons: ["Invalid broker/risk values"],
      volume: 0,
    };
  if (!s.connected) reasons.push("MT5 connection not verified");
  if (!["demo", "live"].includes(s.mode))
    reasons.push("Unsupported account type");
  if (s.mode === "live" && s.liveAuthorized !== true)
    reasons.push("Live execution is not authorized");
  if (s.mode === "demo" && s.demoAuthorized !== true)
    reasons.push("Demo execution is not authorized");
  if (s.safetyVerified !== true)
    reasons.push("Execution safety checks are incomplete");
  if (!s.newsVerified || s.newsBlocked)
    reasons.push("News safety unavailable or blocked");
  if (s.dailyLoss >= s.dayStartEquity * dailyLimit)
    reasons.push("Daily loss limit reached");
  if (s.openPositions >= positionLimit)
    reasons.push("Maximum position limit reached");
  if ((s.peakEquity - s.equity) / s.peakEquity >= s.maxDrawdown)
    reasons.push("Drawdown limit reached");
  if (s.spread > s.maxSpread || s.slippage > s.maxSlippage)
    reasons.push("Execution costs exceed limits");
  if (
    !["BUY", "SELL"].includes(s.side) ||
    (s.side === "BUY" ? s.stop >= s.entry : s.stop <= s.entry)
  )
    reasons.push("Invalid protective stop");
  const risk = Math.min(s.balance, s.equity) * perTrade;
  const lossPerLot = (Math.abs(s.entry - s.stop) / s.tickSize) * s.tickValue;
  const volume =
    lossPerLot > 0
      ? Math.floor(
          (Math.min(risk / lossPerLot, s.maxVolume) + 1e-12) / s.volumeStep,
        ) * s.volumeStep
      : 0;
  if (volume < s.minVolume) reasons.push("Minimum lot exceeds risk budget");
  if (
    s.existingRisk + volume * lossPerLot >
    Math.min(s.balance, s.equity) * aggregateLimit + 1e-8
  )
    reasons.push("Aggregate exposure exceeds 3%");
  return {
    approved: reasons.length === 0,
    reasons,
    volume: reasons.length ? 0 : Number(volume.toFixed(8)),
    riskBudget: risk,
  };
}
