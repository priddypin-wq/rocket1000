import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// This is only an extra eligibility gate. It cannot authorize an order or
// replace the independent per-trade, account-exposure and broker checks.
export function winningAdditionAllowed(ctx, side) {
  const m = ctx?.market,
    e = ctx?.execution;
  if (!m || !Array.isArray(m.positions) || !["BUY", "SELL"].includes(side))
    return false;
  const existing = m.positions.filter((p) => p.symbol === m.symbol);
  if (!existing.length) return true;
  const limit = Math.min(3, ctx.settings?.maxPositions ?? 3);
  if (
    !e ||
    e.protocol !== 4 ||
    e.engineVersion !== ENGINE_VERSION ||
    e.accountMarginMode !== 2 ||
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
    e.existingRisk >= Math.min(m.balance, m.equity) * 0.03
  )
    return false;
  return existing.every(
    (p) =>
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
        ? m.bid > p.open && p.stop >= p.open
        : m.ask < p.open && p.stop <= p.open),
  );
}
