// Pure validation: approval here never authorizes execution by itself.
export function validateRisk(s) {
  const perTrade = s?.riskPerTrade ?? 0.0025,
    dailyLimit = s?.dailyLossLimit ?? 0.01,
    aggregateLimit = s?.aggregateLimit ?? 0.0025,
    positionLimit = s?.positionLimit ?? 1;
  if (
    ![perTrade, dailyLimit, aggregateLimit, positionLimit].every(
      Number.isFinite,
    ) ||
    perTrade <= 0 ||
    perTrade > 0.0025 ||
    dailyLimit <= 0 ||
    dailyLimit > 0.01 ||
    aggregateLimit <= 0 ||
    aggregateLimit > 0.0025 ||
    !Number.isInteger(positionLimit) ||
    positionLimit < 1 ||
    positionLimit > 1
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
  // Execution telemetry always supplies free margin. This pure helper also
  // supports historical numerical callers, but must never approve a supplied
  // zero, negative or non-finite broker margin value. The EA independently
  // calculates exact order margin and runs OrderCheck immediately before send.
  if (
    s.freeMargin !== undefined &&
    (!Number.isFinite(s.freeMargin) || s.freeMargin <= 0)
  )
    reasons.push("No verified free margin available");
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
  const capital = Math.min(s.balance, s.equity);
  const risk = Math.max(
    0,
    Math.min(capital * perTrade, capital * aggregateLimit - s.existingRisk),
  );
  const costs = s.commissionPerLot ?? 0;
  if (!Number.isFinite(costs) || costs < 0)
    return {
      approved: false,
      reasons: ["Unverified execution costs"],
      volume: 0,
    };
  const lossPerLot =
    (Math.abs(s.entry - s.stop) / s.tickSize) * s.tickValue + costs;
  const rawVolume =
    lossPerLot > 0
      ? Math.floor(
          (Math.min(risk / lossPerLot, s.maxVolume) + 1e-12) / s.volumeStep,
        ) * s.volumeStep
      : 0;
  // The EA wire format supports eight decimal places. Validate the normalized
  // value itself: rounding must not turn a tiny broker lot into an oversized or
  // off-step order after the risk checks have already passed.
  const volume = Number(rawVolume.toFixed(8));
  if (volume < s.minVolume) reasons.push("Minimum lot exceeds risk budget");
  if (
    !Number.isFinite(volume) ||
    volume > s.maxVolume ||
    Math.abs(volume / s.volumeStep - Math.round(volume / s.volumeStep)) >
      1e-5 ||
    volume * lossPerLot > risk + 1e-8
  )
    reasons.push("Broker volume precision or per-trade risk is invalid");
  if (
    s.existingRisk + volume * lossPerLot >
    Math.min(s.balance, s.equity) * aggregateLimit + 1e-8
  )
    reasons.push("Aggregate exposure exceeds the hard risk limit");
  return {
    approved: reasons.length === 0,
    reasons,
    volume: reasons.length ? 0 : volume,
    riskBudget: risk,
  };
}
