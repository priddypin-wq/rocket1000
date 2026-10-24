import { send } from "@vercel/queue";
import { engineService, stopAnalysis } from "./engine-service.mjs";
import { ApiError } from "./errors.mjs";

export const analysisQueueSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_queue_dispatch (connection_id TEXT PRIMARY KEY,run_id TEXT NOT NULL DEFAULT '',next_cursor BIGINT NOT NULL DEFAULT 0,lease_until BIGINT NOT NULL DEFAULT 0,last_probe BIGINT NOT NULL DEFAULT 0,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
];
const TOPIC = "rocket1000-analysis";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const active = (row) => ["scheduled", "running"].includes(row?.state);

// A durable queue invokes bounded cycles; the browser never acts as a worker.
export function analysisQueue(
  db,
  {
    env = process.env,
    now = Date.now,
    publish = send,
    engine = engineService(db, { env, now }),
  } = {},
) {
  const enabled = env.VERCEL === "1" && env.ROCKET_QUEUE_ANALYSIS === "1";
  async function connection(uid) {
    const [c] = await db.query(
      "SELECT id FROM rocket_direct_connections WHERE user_id=?",
      [uid],
    );
    return c?.id;
  }
  async function publishMessage(connectionId, runId, cursor, delaySeconds = 0) {
    await publish(
      TOPIC,
      { connectionId, runId, cursor },
      {
        delaySeconds,
        retentionSeconds: 3600,
        idempotencyKey: `${connectionId}:${runId || "probe"}:${cursor}`,
      },
    );
  }
  async function probe(uid) {
    if (!enabled) return;
    const cid = await connection(uid);
    if (!cid) return;
    const [a] = await db.query(
      "SELECT run_id,state FROM rocket_analysis_engine WHERE connection_id=?",
      [cid],
    );
    if ((await engine.scheduler(cid, active(a) ? a.run_id : null)).configured)
      return;
    const stamp = now();
    const reserved = await db.transaction(async (tx) => {
      await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [cid],
      );
      const [row] = await tx.query(
        "SELECT last_probe FROM rocket_queue_dispatch WHERE connection_id=?",
        [cid],
      );
      if (row && stamp - Number(row.last_probe) < 120000) return false;
      await tx.query(
        "INSERT INTO rocket_queue_dispatch(connection_id,last_probe) VALUES(?,?) ON CONFLICT(connection_id) DO UPDATE SET last_probe=excluded.last_probe",
        [cid, stamp],
      );
      return true;
    });
    if (!reserved) return;
    try {
      // The callback alone records liveness. Accepted publishing proves no worker health.
      await publishMessage(cid, null, stamp);
    } catch {
      await db.query(
        "UPDATE rocket_queue_dispatch SET last_probe=0 WHERE connection_id=? AND last_probe=?",
        [cid, stamp],
      );
      throw new ApiError(
        503,
        "Background scheduler could not be reached. Retry shortly; AI has not started.",
        "AI_SCHEDULER_UNAVAILABLE",
      );
    }
  }
  async function suspend(cid, runId) {
    await db.transaction(async (tx) => {
      await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [cid],
      );
      const [row] = await tx.query(
        "SELECT run_id,state FROM rocket_analysis_engine WHERE connection_id=?",
        [cid],
      );
      if (row?.run_id !== runId || !active(row)) return;
      await stopAnalysis(
        tx,
        cid,
        now(),
        "Background scheduling interrupted. Restart AI explicitly.",
      );
      await tx.query(
        "UPDATE rocket_analysis_engine SET state='suspended' WHERE connection_id=?",
        [cid],
      );
    });
  }
  async function start(uid) {
    if (enabled) await probe(uid);
    const status = await engine.start(uid);
    if (!enabled) return status;
    const cid = await connection(uid);
    const [a] = await db.query(
      "SELECT run_id,state FROM rocket_analysis_engine WHERE connection_id=?",
      [cid],
    );
    if (!active(a)) return engine.status(uid);
    try {
      await db.query(
        "INSERT INTO rocket_queue_dispatch(connection_id,run_id) VALUES(?,?) ON CONFLICT(connection_id) DO UPDATE SET run_id=excluded.run_id,next_cursor=CASE WHEN rocket_queue_dispatch.run_id=excluded.run_id THEN rocket_queue_dispatch.next_cursor ELSE 0 END,lease_until=CASE WHEN rocket_queue_dispatch.run_id=excluded.run_id THEN rocket_queue_dispatch.lease_until ELSE 0 END",
        [cid, a.run_id],
      );
      const [dispatch] = await db.query(
        "SELECT next_cursor FROM rocket_queue_dispatch WHERE connection_id=?",
        [cid],
      );
      await publishMessage(cid, a.run_id, Number(dispatch.next_cursor));
      return engine.status(uid);
    } catch {
      await suspend(cid, a.run_id);
      throw new ApiError(
        503,
        "AI did not start: background scheduling failed. No new orders are authorized.",
        "AI_SCHEDULER_UNAVAILABLE",
      );
    }
  }
  async function consume(message) {
    if (!enabled) throw new ApiError(503, "Queue analysis is disabled");
    if (
      !message ||
      Object.keys(message).sort().join() !== "connectionId,cursor,runId" ||
      !uuid.test(message.connectionId) ||
      !(message.runId === null || uuid.test(message.runId)) ||
      !Number.isSafeInteger(message.cursor) ||
      message.cursor < 0
    )
      throw new ApiError(400, "Invalid analysis queue message");
    const { connectionId: cid, runId, cursor } = message;
    const [c] = await db.query(
      "SELECT id FROM rocket_direct_connections WHERE id=?",
      [cid],
    );
    if (!c) return;
    if (runId === null) {
      await engine.heartbeat("queue", `queue:${cid}:probe`);
      return;
    }
    const claimed = await db.transaction(async (tx) => {
      await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [cid],
      );
      const [a] = await tx.query(
        "SELECT run_id,state FROM rocket_analysis_engine WHERE connection_id=?",
        [cid],
      );
      if (a?.run_id !== runId || !active(a)) return false;
      const [d] = await tx.query(
        "SELECT * FROM rocket_queue_dispatch WHERE connection_id=?",
        [cid],
      );
      if (!d || d.run_id !== runId || cursor < Number(d.next_cursor))
        return false;
      if (cursor > Number(d.next_cursor) || Number(d.lease_until) > now())
        throw new ApiError(409, "Analysis delivery already in progress");
      await tx.query(
        "UPDATE rocket_queue_dispatch SET lease_until=? WHERE connection_id=? AND run_id=?",
        [now() + 90000, cid, runId],
      );
      return true;
    });
    if (!claimed) return;
    try {
      await engine.heartbeat("queue", `queue:${cid}:${runId}`);
      await engine.cycle(cid, runId);
      const [a] = await db.query(
        "SELECT run_id,state FROM rocket_analysis_engine WHERE connection_id=?",
        [cid],
      );
      if (a?.run_id === runId && active(a)) {
        // Keep liveness fresh between less frequent, budgeted analysis cycles.
        await publishMessage(cid, runId, cursor + 1, 60);
      }
      await db.query(
        "UPDATE rocket_queue_dispatch SET next_cursor=?,lease_until=0 WHERE connection_id=? AND run_id=? AND next_cursor=?",
        [cursor + 1, cid, runId, cursor],
      );
    } catch (error) {
      await suspend(cid, runId);
      throw error;
    }
  }
  return { enabled, probe, start, consume };
}
