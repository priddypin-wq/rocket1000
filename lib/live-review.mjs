// The visible review belongs to one account, installation and terminal session.
// A matching account number alone must not make an old review actionable.
export function liveReviewMatches(
  review,
  trade,
  orders,
  now,
  unavailable = false,
) {
  return !!(
    !unavailable &&
    review &&
    Number.isFinite(now) &&
    review.expiresAt > now &&
    review.account?.type === "live" &&
    trade?.account?.type === "live" &&
    orders?.account?.type === "live" &&
    orders.connection?.fresh &&
    review.accountKey &&
    review.accountKey === trade.accountKey &&
    review.accountKey === orders.accountKey &&
    review.account.login === trade.account.login &&
    review.account.login === orders.account.login &&
    review.account.server === trade.account.server &&
    review.account.server === orders.account.server &&
    review.installationId &&
    review.installationId === trade.installationId &&
    review.installationId === orders.connection.installationId &&
    review.sessionId &&
    review.sessionId === trade.sessionId &&
    review.sessionId === orders.connection.sessionId &&
    review.settingsRevision === trade.settingsRevision
  );
}
