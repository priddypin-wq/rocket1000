import { billingAdminSummary } from "./billing.mjs";
import { ApiError } from "./errors.mjs";

export async function ownerStatus(db, session, now = Date.now) {
  if (session?.kind !== "account" || session.role !== "owner")
    throw new ApiError(
      403,
      "Owner access is required.",
      "OWNER_ACCESS_REQUIRED",
    );
  const stamp = now();
  const [billing, [usage], [service], customers] = await Promise.all([
    billingAdminSummary(db, { now }),
    db.query(
      "SELECT COUNT(*) AS requests,COALESCE(SUM(charged_microusd),0) AS charged,COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_microusd ELSE 0 END),0) AS reserved FROM rocket_ai_usage WHERE day_bucket=?",
      [Math.floor(stamp / 86400000)],
    ),
    db.query(
      "SELECT COUNT(*) AS checked_in FROM rocket_engine_scheduler WHERE last_seen>?",
      [stamp - 150000],
    ),
    db.query(
      `SELECT u.id,
         CASE WHEN EXISTS(SELECT 1 FROM rocket_billing_subscriptions s WHERE s.workspace_id=u.workspace_id AND s.expires_at>?) THEN 1 ELSE 0 END AS subscribed,
         CASE WHEN EXISTS(SELECT 1 FROM rocket_direct_installations i WHERE i.connection_id=c.id AND i.revoked_at IS NULL AND i.expires_at>? AND i.last_heartbeat>? AND i.last_error IS NULL) THEN 1 ELSE 0 END AS connected,
         COALESCE(a.state,'stopped') AS analysis
       FROM rocket_users u LEFT JOIN rocket_direct_connections c ON c.user_id=u.workspace_id
       LEFT JOIN rocket_analysis_engine a ON a.connection_id=c.id
       ORDER BY u.created_at DESC,u.id LIMIT 50`,
      [stamp, stamp, stamp - 30000],
    ),
  ]);
  return {
    billing,
    usage: {
      requests: Number(usage.requests),
      chargedUsd: Number(usage.charged) / 1e6,
      reservedUsd: Number(usage.reserved) / 1e6,
    },
    workerCheckIn: Number(service.checked_in) > 0,
    customers: customers.map((customer) => ({
      reference: customer.id,
      subscribed: Number(customer.subscribed) === 1,
      connected: Number(customer.connected) === 1,
      analysis: customer.analysis,
    })),
  };
}
