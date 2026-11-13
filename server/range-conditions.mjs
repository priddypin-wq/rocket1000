// Eligibility from completed, authenticated candles. This never generates an
// order: OpenAI must choose a proposal and both execution boundaries recheck it.
export function rangeConditions(snapshot, profile, execution, costs) {
  const unavailable = {
    eligible: false,
    side: null,
    support: null,
    resistance: null,
    reason:
      "A confirmed range-bound rejection, fresh costs and broker permissions are required.",
  };
  const bars = snapshot.timeframes?.M5?.bars;
  const confirmation = snapshot.timeframes?.M1?.bars;
  if (
    !profile.ready ||
    profile.regime !== "range" ||
    profile.effectiveRiskPct <= 0 ||
    profile.frames?.M15?.trend?.direction !== "range" ||
    !execution ||
    execution.sessionOpen !== true ||
    execution.tradeAllowed !== true ||
    ![1, 2, 4].includes(execution.symbolTradeMode) ||
    ![0, 1, 2, 3].includes(execution.tradeExecutionMode) ||
    !Number.isInteger(execution.orderMode) ||
    (execution.orderMode & 1) !== 1 ||
    !Number.isFinite(costs) ||
    costs < 0 ||
    !Array.isArray(bars) ||
    bars.length < 42 ||
    !Array.isArray(confirmation) ||
    confirmation.length < 2
  )
    return unavailable;
  const prior = bars.slice(-42, -2);
  if (
    !prior.every(
      (b, i) =>
        [b.low, b.high, b.open, b.close, b.time].every(
          (n) => Number.isFinite(n) && n > 0,
        ) &&
        b.low <= Math.min(b.open, b.close) &&
        b.high >= Math.max(b.open, b.close) &&
        (!i || b.time > prior[i - 1].time),
    )
  )
    return unavailable;
  const support = Math.min(...prior.map((b) => b.low));
  const resistance = Math.max(...prior.map((b) => b.high));
  const width = resistance - support;
  const atr = profile.frames?.M5?.atr14;
  if (
    ![snapshot.bid, snapshot.ask, atr, width].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    snapshot.ask < snapshot.bid ||
    width <= costs * 6 ||
    atr >= width / 2
  )
    return unavailable;
  // Two separate historical touches are needed at each boundary. The latest
  // two candles cannot create their own range or retrospectively move its edges.
  const tolerance = Math.min(width * 0.1, atr * 0.5);
  if (
    prior.filter((b) => b.low <= support + tolerance).length < 2 ||
    prior.filter((b) => b.high >= resistance - tolerance).length < 2
  )
    return unavailable;
  const [rejection, confirm] = confirmation.slice(-2);
  if (
    ![rejection, confirm].every(
      (b) =>
        [b.low, b.high, b.open, b.close, b.time].every(
          (n) => Number.isFinite(n) && n > 0,
        ) &&
        b.low <= Math.min(b.open, b.close) &&
        b.high >= Math.max(b.open, b.close),
    ) ||
    confirm.time <= rejection.time
  )
    return unavailable;
  const body = Math.max(Math.abs(rejection.close - rejection.open), atr * 0.02);
  const buy =
    rejection.low <= support + tolerance &&
    rejection.low >= support - atr * 0.25 &&
    Math.min(rejection.open, rejection.close) - rejection.low >= body * 2 &&
    confirm.close > confirm.open &&
    confirm.close > rejection.high &&
    snapshot.ask <= support + width * 0.25 &&
    snapshot.bid > support;
  const sell =
    rejection.high >= resistance - tolerance &&
    rejection.high <= resistance + atr * 0.25 &&
    rejection.high - Math.max(rejection.open, rejection.close) >= body * 2 &&
    confirm.close < confirm.open &&
    confirm.close < rejection.low &&
    snapshot.bid >= resistance - width * 0.25 &&
    snapshot.ask < resistance;
  const side = buy && !sell ? "BUY" : sell && !buy ? "SELL" : null;
  return {
    eligible: !!side,
    side,
    support,
    resistance,
    reason: side
      ? "Repeated M5 range boundaries and a completed M1 rejection with a later directional confirmation; costs leave room inside the range."
      : unavailable.reason,
  };
}

export function rangeProposalAllowed(profile, side, stop, target) {
  const r = profile?.range;
  return (
    r?.eligible === true &&
    r.side === side &&
    [r.support, r.resistance, stop, target].every(
      (n) => Number.isFinite(n) && n > 0,
    ) &&
    (side === "BUY"
      ? stop < r.support && target <= r.resistance
      : side === "SELL" && stop > r.resistance && target >= r.support)
  );
}
