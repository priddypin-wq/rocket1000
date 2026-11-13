// Explicit operator release operation, not part of the trading request path.
// Prints aggregate safety evidence only; never exports credentials or positions.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getDatabase } from "../server/database.mjs";
import { pauseActivation } from "../server/engine-activation.mjs";
import { stopAnalysis } from "../server/engine-service.mjs";

export async function verifyOff(db) {
  const [row] = await db.query(`SELECT
    (SELECT COUNT(*) FROM rocket_direct_connections) AS connections,
    (SELECT COUNT(*) FROM rocket_direct_connections WHERE stopped<>1) AS connections_not_stopped,
    (SELECT COUNT(*) FROM rocket_direct_connections c LEFT JOIN rocket_engine_activation a ON a.connection_id=c.id WHERE a.paused IS NULL OR a.paused<>1) AS activations_not_paused,
    (SELECT COUNT(*) FROM rocket_direct_connections c LEFT JOIN rocket_analysis_activation a ON a.connection_id=c.id WHERE a.paused IS NULL OR a.paused<>1) AS analysis_not_paused,
    (SELECT COUNT(*) FROM rocket_analysis_engine WHERE state IN ('scheduled','running','verifying')) AS active_engines,
    (SELECT COUNT(*) FROM rocket_automation WHERE state IN ('running','reconnecting')) AS active_automation,
    (SELECT COUNT(*) FROM rocket_trade_policy) AS policies,
    (SELECT COUNT(*) FROM rocket_trade_commands WHERE status='queued') AS queued_commands,
    (SELECT COUNT(*) FROM rocket_trade_commands WHERE status IN ('claimed','sending')) AS in_flight_commands,
    (SELECT COUNT(*) FROM rocket_trade_commands WHERE status='uncertain') AS uncertain_commands`);
  const stats = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  );
  for (const key of [
    "connections_not_stopped",
    "activations_not_paused",
    "analysis_not_paused",
    "active_engines",
    "active_automation",
    "policies",
    "queued_commands",
  ])
    if (stats[key] !== 0)
      throw Error("Release safety invariant failed: " + key);
  if (stats.in_flight_commands !== 0)
    throw Error(
      "Existing broker submission outcome is pending. Trading remains OFF; never retry it to complete a release.",
    );
  // An uncertain historical result stays unresolved and blocks execution. A
  // release must not invent a broker acknowledgement to make this count zero.
  return { tradingOff: true, ...stats };
}

export async function pauseAll(db, now = Date.now) {
  const credentials = () =>
    db.query(
      "SELECT id,token_hash,expires_at,revoked_at FROM rocket_direct_installations ORDER BY id",
    );
  const before = JSON.stringify(await credentials());
  await db.transaction(async (tx) => {
    const rows = await tx.query(
      "SELECT id,user_id FROM rocket_direct_connections ORDER BY id" +
        (tx.kind === "postgres" ? " FOR UPDATE" : ""),
    );
    for (const connection of rows) {
      await pauseActivation(
        tx,
        connection.id,
        "Approved release: Auto Trading OFF.",
      );
      await stopAnalysis(
        tx,
        connection.id,
        now(),
        "Approved release: Auto Trading OFF.",
      );
      await tx.query(
        "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
        [connection.id],
      );
      await tx.query(
        "DELETE FROM rocket_order_previews WHERE connection_id=?",
        [connection.id],
      );
      await tx.query(
        "INSERT INTO rocket_direct_audit(id,user_id,connection_id,event,created_at) VALUES(?,?,?,?,?)",
        [
          randomUUID(),
          connection.user_id,
          connection.id,
          "approved_release_trading_paused",
          now(),
        ],
      );
    }
  });
  if (before !== JSON.stringify(await credentials()))
    throw Error(
      "Installation credentials changed during release check. Do not promote.",
    );
  return { ...(await verifyOff(db)), existingCredentialsUnchanged: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.env.VERCEL !== "1" || !process.env.DATABASE_URL)
    throw Error(
      "Release safety requires the linked Vercel PostgreSQL environment.",
    );
  if (
    process.env.VERCEL_PROJECT_ID &&
    process.env.VERCEL_PROJECT_ID !== "prj_oTLaK79PdNcNy8dpXiINtTiqlAsC"
  )
    throw Error("Wrong release project.");
  const action = process.argv[2];
  if (!["--apply", "--check"].includes(action))
    throw Error("Choose --apply or --check explicitly.");
  const db = getDatabase();
  try {
    const result =
      action === "--apply" ? await pauseAll(db) : await verifyOff(db);
    console.log("ROCKET1000_RELEASE_SAFETY " + JSON.stringify(result));
  } finally {
    await db.close();
  }
}
