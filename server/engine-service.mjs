import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.mjs";
import { provisioningService } from "./provisioning.mjs";
import { analysisService } from "./analysis-service.mjs";
import { analyzeMarket } from "./ai-analysis.mjs";
import { openaiCredentialService as credentialService } from "./openai-credentials.mjs";
import { usageService, defaultDailyBudget } from "./ai-usage.mjs";
import { tradeContext, disableTrading } from "./trading.mjs";
import { automationService } from "./automation.mjs";
import { decisionBar, requireMultiTimeframe } from "./market.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";

export const analysisEngineSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_analysis_engine (connection_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,state TEXT NOT NULL,installation_id TEXT NOT NULL,session_id TEXT NOT NULL,account_key TEXT NOT NULL,key_revision TEXT NOT NULL,frequency_seconds INTEGER NOT NULL DEFAULT 300,daily_budget_microusd BIGINT NOT NULL DEFAULT 2000000,last_cycle BIGINT NOT NULL DEFAULT 0,next_cycle BIGINT NOT NULL DEFAULT 0,last_bar BIGINT NOT NULL DEFAULT 0,lease_until BIGINT NOT NULL DEFAULT 0,reason TEXT,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS rocket_engine_scheduler (id TEXT PRIMARY KEY,mode TEXT NOT NULL,last_seen BIGINT NOT NULL)`,
];
export async function stopAnalysis(
  tx,
  cid,
  now = Date.now(),
  reason = "Stopped by user",
) {
  await tx.query(
    "UPDATE rocket_analysis_engine SET state='stopped',run_id=?,lease_until=0,reason=? WHERE connection_id=?",
    [randomUUID(), reason, cid],
  );
  await tx.query(
    "UPDATE rocket_analyses SET status='cancelled',error=?,completed_at=? WHERE connection_id=? AND status='analyzing'",
    [reason, now, cid],
  );
  await disableTrading(tx, cid, now);
}
export async function credentialChanged(uid, tx) {
  const [c] = await tx.query(
    "SELECT id FROM rocket_direct_connections WHERE user_id=?",
    [uid],
  );
  if (c)
    await stopAnalysis(
      tx,
      c.id,
      Date.now(),
      "OpenAI credential changed. Verify and restart explicitly.",
    );
  if (c)
    await tx.query("DELETE FROM rocket_ai_health WHERE connection_id=?", [
      c.id,
    ]);
}
export function engineService(
  db,
  {
    now = Date.now,
    env = process.env,
    credentials,
    analyzer = analyzeMarket,
    provider,
  } = {},
) {
  const usage = usageService(db, {
    now,
    env,
    ...(provider ? { provider } : {}),
  });
  const keys = (uid) =>
    credentials ||
    credentialService(db, {
      now,
      env,
      onChange: credentialChanged,
      responder: usage.responder(uid, "connection-test"),
    });
  async function scheduler(connectionId = null, runId = null) {
    const [row] = await db.query(
      "SELECT mode,last_seen FROM rocket_engine_scheduler WHERE mode IN ('worker','cron') OR (mode='queue' AND id IN (?,?)) ORDER BY last_seen DESC LIMIT 1",
      [
        connectionId ? `queue:${connectionId}:probe` : "",
        connectionId && runId ? `queue:${connectionId}:${runId}` : "",
      ],
    );
    return {
      configured: !!row && now() - Number(row.last_seen) < 150000,
      mode: row?.mode || "not-started",
      lastSeen: row ? Number(row.last_seen) : null,
    };
  }
  async function heartbeat(mode = "worker", id = "primary") {
    const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    if (
      !["worker", "cron", "queue"].includes(mode) ||
      (mode === "queue" &&
        !new RegExp(`^queue:${uuid}:(?:probe|${uuid})$`, "i").test(id))
    )
      throw new ApiError(400, "Invalid scheduler mode");
    await db.query(
      "INSERT INTO rocket_engine_scheduler(id,mode,last_seen) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,last_seen=excluded.last_seen",
      [id, mode, now()],
    );
  }
  async function status(uid) {
    const [c] = await db.query(
      "SELECT id FROM rocket_direct_connections WHERE user_id=?",
      [uid],
    );
    const [row] = c
      ? await db.query(
          "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
          [c.id],
        )
      : [];
    const ready = await scheduler(c?.id, row?.run_id);
    let state = row?.state || "stopped",
      reason = row?.reason || null;
    if (["scheduled", "running"].includes(state) && !ready.configured) {
      state = "suspended";
      reason =
        "Analysis worker is offline. No new analysis or automated orders are authorized.";
    }
    if (
      ["running", "verifying"].includes(row?.state) &&
      Number(row.lease_until) <= now()
    ) {
      state = "suspended";
      reason =
        "Previous analysis was interrupted. Restart explicitly; its outcome is not retried.";
    }
    return {
      state,
      reason,
      lastCycle: row?.last_cycle ? Number(row.last_cycle) : null,
      nextCycle: row?.next_cycle ? Number(row.next_cycle) : null,
      frequencySeconds: row ? Number(row.frequency_seconds) : 300,
      scheduler: ready,
      usage: await usage.totals(uid),
      engineVersion: ENGINE_VERSION,
      executionAuthorized: false,
    };
  }
  async function start(uid) {
    const previous = await status(uid);
    if (["scheduled", "running"].includes(previous.state)) return previous;
    const [ownedConnection] = await db.query(
      "SELECT id FROM rocket_direct_connections WHERE user_id=?",
      [uid],
    );
    if (!(await scheduler(ownedConnection?.id)).configured)
      throw new ApiError(
        503,
        "The persistent analysis worker has not checked in. Start the server worker or configure the authenticated scheduler first.",
        "AI_SCHEDULER_NOT_READY",
      );
    const credential = keys(uid),
      keyBefore = await credential.status(uid);
    if (!keyBefore.configured)
      throw new ApiError(
        409,
        "Save your OpenAI API key in Settings first.",
        "AI_AUTH_REQUIRED",
      );
    const [connection] = await provisioningService(db, { now }).list(uid);
    if (!connection || connection.status !== "Connected")
      throw new ApiError(
        409,
        "Connect MT5 and wait for a fresh EA heartbeat.",
        "MT5_NOT_CONNECTED",
      );
    const operationId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [connection.id],
      );
      const ctx = await tradeContext(tx, connection.id, now());
      if (
        !ctx.market ||
        !ctx.i?.registered_at ||
        !ctx.x ||
        now() - Number(ctx.i.last_heartbeat) > 30000 ||
        now() - Number(ctx.x.received_at) > 30000 ||
        ctx.execution.engineVersion !== ENGINE_VERSION
      )
        throw new ApiError(
          409,
          "Fresh verified account, broker data and current EA engine are required.",
          "MT5_DATA_NOT_VERIFIED",
        );
      requireMultiTimeframe(ctx.market);
      const [active] = await tx.query(
        "SELECT state,lease_until FROM rocket_analysis_engine WHERE connection_id=?",
        [ctx.c.id],
      );
      if (
        ["scheduled", "running"].includes(active?.state) ||
        (active?.state === "verifying" && Number(active.lease_until) > now())
      )
        throw new ApiError(
          409,
          "AI Start is already in progress.",
          "AI_START_IN_PROGRESS",
        );
      await tx.query(
        "INSERT INTO rocket_analysis_engine(connection_id,run_id,state,installation_id,session_id,account_key,key_revision,daily_budget_microusd,next_cycle,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,installation_id=excluded.installation_id,session_id=excluded.session_id,account_key=excluded.account_key,key_revision=excluded.key_revision,next_cycle=excluded.next_cycle,last_bar=0,lease_until=excluded.lease_until,reason=NULL",
        [
          ctx.c.id,
          operationId,
          "verifying",
          ctx.i.id,
          ctx.x.session_id,
          ctx.consent.key,
          String(keyBefore.revision || "environment"),
          Math.round(defaultDailyBudget(env) * 1e6),
          now(),
          now() + 90000,
        ],
      );
    });
    try {
      // STOP invalidates this operation while its bounded diagnostic awaits IO.
      const verification = keyBefore.connection?.connected
        ? keyBefore.connection
        : await credential.test(uid);
      if (!(verification?.connected || verification?.connection?.connected))
        throw new ApiError(
          409,
          verification?.error ||
            verification?.connection?.error ||
            "OpenAI verification failed. Check Settings.",
          verification?.errorCode ||
            verification?.connection?.errorCode ||
            "AI_CONNECTION_REQUIRED",
        );
      const keyAfter = await credential.status(uid);
      if (keyAfter.revision !== keyBefore.revision)
        throw new ApiError(
          409,
          "The key changed during verification. Retry Start.",
          "AI_CONFIGURATION_CHANGED",
        );
      await db.transaction(async (tx) => {
        await tx.query(
          `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [connection.id],
        );
        const [a] = await tx.query(
          "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
          [connection.id],
        );
        const ctx = await tradeContext(tx, connection.id, now());
        if (
          !a ||
          a.run_id !== operationId ||
          a.state !== "verifying" ||
          Number(a.lease_until) <= now() ||
          a.installation_id !== ctx.i?.id ||
          a.session_id !== ctx.x?.session_id ||
          a.account_key !== ctx.consent.key ||
          !ctx.market ||
          now() - Number(ctx.i?.last_heartbeat) > 30000 ||
          now() - Number(ctx.x?.received_at) > 30000
        )
          throw new ApiError(
            409,
            "Start was stopped or the account changed during verification.",
            "AI_START_CANCELLED",
          );
        await tx.query(
          "UPDATE rocket_analysis_engine SET state='scheduled',lease_until=0,next_cycle=? WHERE connection_id=? AND run_id=?",
          [now(), connection.id, operationId],
        );
      });
    } catch (error) {
      await db.query(
        "UPDATE rocket_analysis_engine SET state='suspended',lease_until=0,reason=? WHERE connection_id=? AND run_id=? AND state='verifying'",
        [
          error instanceof ApiError
            ? error.message
            : "OpenAI verification failed.",
          connection.id,
          operationId,
        ],
      );
      throw error;
    }
    return status(uid);
  }
  async function stop(uid) {
    await db.transaction(async (tx) => {
      const [c] = await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE user_id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [uid],
      );
      if (c) await stopAnalysis(tx, c.id, now());
    });
    return status(uid);
  }
  async function configure(uid, input) {
    const frequency = input.frequencySeconds,
      budget = input.dailyBudgetUsd;
    if (
      !Number.isInteger(frequency) ||
      frequency < 60 ||
      frequency > 3600 ||
      !Number.isFinite(budget) ||
      budget < 0.1 ||
      budget > 10
    )
      throw new ApiError(
        422,
        "Analysis frequency must be 60–3600 seconds and daily budget $0.10–$10.",
      );
    const [c] = await db.query(
      "SELECT id FROM rocket_direct_connections WHERE user_id=?",
      [uid],
    );
    if (!c)
      throw new ApiError(409, "Create the existing MT5 connection first.");
    await db.transaction(async (tx) => {
      await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [c.id],
      );
      await stopAnalysis(
        tx,
        c.id,
        now(),
        "Analysis cost settings changed. Restart explicitly.",
      );
      await tx.query(
        "INSERT INTO rocket_analysis_engine(connection_id,run_id,state,installation_id,session_id,account_key,key_revision,frequency_seconds,daily_budget_microusd) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET frequency_seconds=excluded.frequency_seconds,daily_budget_microusd=excluded.daily_budget_microusd",
        [
          c.id,
          randomUUID(),
          "stopped",
          "",
          "",
          "",
          "",
          frequency,
          Math.floor(budget * 1e6),
        ],
      );
    });
    return status(uid);
  }
  async function cycle(cid, expectedRun = null) {
    let job, observedRun;
    try {
      job = await db.transaction(async (tx) => {
        await tx.query(
          `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [cid],
        );
        const [a] = await tx.query(
          "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
          [cid],
        );
        if (
          !a ||
          (expectedRun !== null && a.run_id !== expectedRun) ||
          !["scheduled", "running"].includes(a.state)
        )
          return null;
        observedRun = a.run_id;
        if (a.state === "running") {
          if (Number(a.lease_until) <= now())
            await stopAnalysis(
              tx,
              cid,
              now(),
              "Analysis request interrupted. Verify provider and restart explicitly.",
            );
          return null;
        }
        if (Number(a.next_cycle) > now()) return null;
        const ctx = await tradeContext(tx, cid, now());
        if (
          !ctx.market ||
          !ctx.i ||
          !ctx.x ||
          a.installation_id !== ctx.i.id ||
          a.session_id !== ctx.x.session_id ||
          a.account_key !== ctx.consent.key ||
          now() - Number(ctx.i.last_heartbeat) > 30000 ||
          now() - Number(ctx.x.received_at) > 30000 ||
          ctx.execution.engineVersion !== ENGINE_VERSION
        )
          throw new ApiError(
            409,
            "MT5 identity, connection or fresh broker data could not be verified.",
            "MT5_DATA_STALE",
          );
        requireMultiTimeframe(ctx.market);
        const bar = decisionBar(ctx.market);
        if (Number(a.last_bar) === bar) {
          await tx.query(
            "UPDATE rocket_analysis_engine SET next_cycle=? WHERE connection_id=?",
            [now() + Number(a.frequency_seconds) * 1000, cid],
          );
          return null;
        }
        await tx.query(
          "UPDATE rocket_analysis_engine SET state='running',last_cycle=?,last_bar=?,lease_until=?,reason=NULL WHERE connection_id=?",
          [now(), bar, now() + 90000, cid],
        );
        return { ...a, uid: ctx.c.user_id, cid, bar };
      });
      if (!job) return { state: "idle" };
      const key = keys(job.uid),
        metadata = await key.status(job.uid);
      if (String(metadata.revision || "environment") !== job.key_revision)
        throw new ApiError(
          409,
          "OpenAI credential changed. Restart explicitly.",
          "AI_CONFIGURATION_CHANGED",
        );
      const requestEnv = await key.environment(job.uid);
      const guard = async (tx) => {
        const [row] = await tx.query(
          "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
          [cid],
        );
        if (
          !row ||
          row.run_id !== job.run_id ||
          row.state !== "running" ||
          Number(row.lease_until) <= now()
        )
          throw new ApiError(
            409,
            "AI stopped or restarted; in-flight result discarded.",
            "ANALYSIS_CANCELLED",
          );
      };
      const budgeted = usage.responder(job.uid, "analysis", {
        runId: job.run_id,
        beforeDispatch: guard,
      });
      const guardedResponder = async (payload, options = {}) => {
        const abort = new AbortController();
        let checking = false;
        const timer = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            await db.transaction(guard);
          } catch {
            abort.abort();
          } finally {
            checking = false;
          }
        }, 1000);
        try {
          return await budgeted(payload, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([options.signal, abort.signal])
              : abort.signal,
          });
        } finally {
          clearInterval(timer);
        }
      };
      await analysisService(db, {
        now,
        analyzer,
        resolveEnvironment: async () => requestEnv,
        responder: guardedResponder,
        beforeSnapshot: guard,
        beforePersist: guard,
      }).start(job.uid);
      const active = await db.transaction(async (tx) => {
        await guard(tx);
        await tx.query(
          "UPDATE rocket_analysis_engine SET state='scheduled',next_cycle=?,lease_until=0,reason=NULL WHERE connection_id=? AND run_id=?",
          [now() + Number(job.frequency_seconds) * 1000, cid, job.run_id],
        );
        return true;
      });
      if (active)
        await automationService(db, { now }).cycle(job.installation_id);
      return { state: "scheduled" };
    } catch (error) {
      await db.transaction(async (tx) => {
        await tx.query(
          `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [cid],
        );
        const [row] = await tx.query(
          "SELECT run_id,state FROM rocket_analysis_engine WHERE connection_id=?",
          [cid],
        );
        if (
          !row ||
          row.run_id !== (job?.run_id || observedRun) ||
          row.state === "stopped"
        )
          return;
        const reason =
          error instanceof ApiError
            ? error.message
            : "Analysis service failed. Check Settings and restart explicitly.";
        await stopAnalysis(tx, cid, now(), reason);
        await tx.query(
          "UPDATE rocket_analysis_engine SET state='suspended' WHERE connection_id=?",
          [cid],
        );
      });
      return { state: "suspended" };
    }
  }
  async function drain({ limit = 2 } = {}) {
    const rows = await db.query(
      "SELECT connection_id FROM rocket_analysis_engine WHERE state IN ('scheduled','running') AND next_cycle<=? ORDER BY next_cycle LIMIT ?",
      [now(), Math.min(10, Math.max(1, limit))],
    );
    const results = [];
    for (const row of rows) results.push(await cycle(row.connection_id));
    return { processed: results.length };
  }
  return { start, stop, configure, status, scheduler, heartbeat, cycle, drain };
}
