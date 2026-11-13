import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// This is only an extra eligibility gate. It cannot authorize an order or
// replace the independent per-trade, account-exposure and broker checks.
export function winningAdditionAllowed(ctx, side) {
  const m = ctx?.market,
    e = ctx?.execution;
  if (!m || !Array.isArray(m.positions) || !["BUY", "SELL"].includes(side))
    return false;
  const existing = m.positions;
  if (!existing.length) return true;
  const limit = Math.min(2, ctx.settings?.maxPositions ?? 1);
  if (
    !e ||
    e.protocol !== 4 ||
    e.engineVersion !== ENGINE_VERSION ||
    e.accountMarginMode !== 2 ||
    e.protectedAdditions !== true ||
    e.positionsAvailable !== true ||
    !Number.isFinite(ctx.now) ||
    !Number.isFinite(m.timestamp) ||
    Math.abs(ctx.now - m.timestamp) > 30000 ||
    !Number.isFinite(m.brokerTimestamp) ||
    !Number.isFinite(m.quoteTimestamp) ||
    m.brokerTimestamp - m.quoteTimestamp > 15000 ||
    m.quoteTimestamp - m.brokerTimestamp > 2000 ||
    ![m.bid, m.ask, m.balance, m.equity].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    m.ask < m.bid ||
    m.positions.length >= limit ||
    !Number.isFinite(e.existingRisk) ||
    e.existingRisk < 0 ||
    e.existingRisk >= Math.min(m.balance, m.equity) * 0.0025 ||
    e.costsVerified !== true ||
    !Number.isFinite(e.commissionPerLot) ||
    e.commissionPerLot < 0 ||
    !Number.isFinite(e.tickSize) ||
    e.tickSize <= 0 ||
    !Number.isFinite(e.tickValue) ||
    e.tickValue <= 0 ||
    !Number.isFinite(e.point) ||
    e.point <= 0
  )
    return false;
  const buffer =
    (e.commissionPerLot / e.tickValue) * e.tickSize +
    (ctx.settings?.maxSlippagePoints ?? 10) * e.point;
  return existing.every(
    (p) =>
      p.symbol === m.symbol &&
      p.managed === true &&
      p.ownedIntegrity === true &&
      p.magic === 100061 &&
      typeof p.ticket === "string" &&
      /^\d{1,20}$/.test(p.ticket) &&
      typeof p.identifier === "string" &&
      /^\d{1,20}$/.test(p.identifier) &&
      typeof p.comment === "string" &&
      /^R1000:[a-f0-9-]{24}$/.test(p.comment) &&
      p.side === side &&
      Number.isFinite(p.profit) &&
      p.profit > 0 &&
      [p.open, p.stop, p.volume].every((n) => Number.isFinite(n) && n > 0) &&
      (side === "BUY"
        ? m.bid > p.stop && p.stop + 1e-8 >= p.open + buffer
        : m.ask < p.stop && p.stop - 1e-8 <= p.open - buffer),
  );
}
