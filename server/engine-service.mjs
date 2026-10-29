import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.mjs";
import {
  assertRequestedAccount,
  executionIdentity,
} from "./requested-account.mjs";
import { provisioningService } from "./provisioning.mjs";
import { analysisService } from "./analysis-service.mjs";
import { analyzeMarket } from "./ai-analysis.mjs";
import { openaiCredentialService as credentialService } from "./openai-credentials.mjs";
import { usageService, defaultDailyBudget } from "./ai-usage.mjs";
import {
  tradeContext,
  disableTrading,
  authorizeUnifiedAutomation,
} from "./trading.mjs";
import { automationService } from "./automation.mjs";
import { decisionBar, requireMultiTimeframe } from "./market.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import {
  activationState,
  analysisActivationState,
  pauseActivation,
  environmentCredentialRevision,
} from "./engine-activation.mjs";

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
      "OpenAI credential changed. Waiting for automatic verification.",
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
  // Internal only: never return an API-key fingerprint to the browser. Unlike
  // a constant "environment" revision, this invalidates jobs after rotation,
  // including a response already in flight when the server secret changes.
  const credentialRevision = (metadata) =>
    !credentials && env.ROCKET_OPENAI_SERVER_MANAGED !== "0"
      ? environmentCredentialRevision(env)
      : String(metadata?.revision || "environment");
  // Only a successfully enabled execution session creates this intent. Analysis
  // startup cannot manufacture it, and current pause/account/terminal fences
  // remain independently necessary before any recovery grants a policy.
  async function executionIntentMatches(tx, cid, ctx) {
    const [intent] = await tx.query(
      "SELECT * FROM rocket_execution_intent WHERE connection_id=?",
      [cid],
    );
    const executionActivation = await activationState(tx, cid);
    return !!(
      intent &&
      !executionActivation.paused &&
      ctx.analysisEngine &&
      ["scheduled", "running", "suspended"].includes(
        ctx.analysisEngine.state,
      ) &&
      intent.account_key === ctx.consent.key &&
      ctx.analysisEngine.account_key === intent.account_key &&
      intent.installation_id === ctx.i?.id &&
      ctx.analysisEngine.installation_id === intent.installation_id &&
      intent.terminal_id === ctx.execution?.terminalId &&
      intent.engine_version === ENGINE_VERSION &&
      ctx.execution?.engineVersion === ENGINE_VERSION &&
      ctx.execution.protocol === 4 &&
      (ctx.i.account_type !== "live" || ctx.consent.confirmed)
    );
  }
  async function executionResumeAllowed(tx, cid, ctx) {
    const [uncertain] = await tx.query(
      "SELECT id FROM rocket_trade_commands WHERE connection_id=? AND status IN ('claimed','sending','uncertain') LIMIT 1",
      [cid],
    );
    return !!(
      (await executionIntentMatches(tx, cid, ctx)) &&
      !uncertain &&
      !ctx.connectionBlockers.length &&
      !(
        ctx.i.account_type === "live" &&
        process.env.ROCKET_DISABLE_LIVE_ORDERS === "1"
      )
    );
  }
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
    const [activation] = c
      ? await db.query(
          "SELECT * FROM rocket_engine_activation WHERE connection_id=?",
          [c.id],
        )
      : [];
    const [analysisActivation] = c
      ? await db.query(
          "SELECT * FROM rocket_analysis_activation WHERE connection_id=?",
          [c.id],
        )
      : [];
    // Infrastructure probes establish scheduler availability, not execution
    // authority. Account/session freshness and active-run liveness are separate.
    const executionContext = c
      ? await db.transaction((tx) => tradeContext(tx, c.id, now()))
      : null;
    let state = row?.state || "stopped",
      reason = row?.reason || activation?.reason || null;
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
        "Previous analysis was interrupted. No order is retried; automatic readiness will be checked again.";
    }
    return {
      state,
      ...executionIdentity(executionContext),
      controlRevision:
        analysisActivation?.generation ||
        activation?.generation ||
        "uninitialized",
      reason,
      lastCycle: row?.last_cycle ? Number(row.last_cycle) : null,
      nextCycle:
        ready.configured &&
        ["scheduled", "running"].includes(state) &&
        row?.next_cycle
          ? Number(row.next_cycle)
          : null,
      frequencySeconds: row ? Number(row.frequency_seconds) : 300,
      scheduler: ready,
      usage: await usage.totals(uid),
      engineVersion: ENGINE_VERSION,
      mode:
        analysisActivation?.mode ||
        (executionContext?.permissionActive ? "execution" : "analysis"),
      automaticAnalysis: {
        paused: analysisActivation
          ? !!analysisActivation.paused
          : !!activation?.paused,
        nextAttempt: analysisActivation?.next_attempt
          ? Number(analysisActivation.next_attempt)
          : null,
        reason: analysisActivation?.reason || null,
      },
      automaticActivation: {
        paused: activation ? !!activation.paused : true,
        nextAttempt: activation?.next_attempt
          ? Number(activation.next_attempt)
          : null,
        reason: activation?.reason || null,
      },
      executionAuthorized: !!(
        executionContext?.permissionActive &&
        executionContext.automation?.state === "running" &&
        ["scheduled", "running"].includes(state)
      ),
    };
  }
  async function start(
    uid,
    {
      automatic = false,
      generation = null,
      analysisOnly = false,
      expectedControlRevision,
      ...expectedAccount
    } = {},
  ) {
    const previous = await status(uid);
    assertRequestedAccount(previous, expectedAccount);
    if (
      expectedControlRevision !== undefined &&
      (typeof expectedControlRevision !== "string" ||
        !/^(?:uninitialized|[a-f0-9-]{36})$/.test(expectedControlRevision))
    )
      throw new ApiError(
        400,
        "Invalid engine control revision.",
        "AI_CONTROL_INVALID",
      );
    if (
      expectedControlRevision !== undefined &&
      expectedControlRevision !== previous.controlRevision
    )
      throw new ApiError(
        409,
        "The engine was stopped or changed. Refresh before starting again.",
        "AI_START_CANCELLED",
      );
    const requestedControlRevision =
      expectedControlRevision ?? previous.controlRevision;
    if (
      ["scheduled", "running"].includes(previous.state) &&
      (analysisOnly
        ? previous.mode === "analysis"
        : previous.executionAuthorized)
    )
      return previous;
    const [owned] = await db.query(
      "SELECT id FROM rocket_direct_connections WHERE user_id=?",
      [uid],
    );
    if (!(await scheduler(owned?.id)).configured)
      throw new ApiError(
        503,
        "The persistent analysis worker has not checked in.",
        "AI_SCHEDULER_NOT_READY",
      );
    const credential = keys(uid),
      keyBefore = await credential.status(uid);
    const revisionBefore = credentialRevision(keyBefore);
    if (!keyBefore.configured)
      throw new ApiError(
        409,
        "The server OpenAI connection is not configured.",
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
    let expectedActivation = generation,
      expectedTerminalId = null;
    await db.transaction(async (tx) => {
      await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [connection.id],
      );
      const [analysisControl] = await tx.query(
        "SELECT generation FROM rocket_analysis_activation WHERE connection_id=?",
        [connection.id],
      );
      const [executionControl] = await tx.query(
        "SELECT generation FROM rocket_engine_activation WHERE connection_id=?",
        [connection.id],
      );
      if (
        (analysisControl?.generation ||
          executionControl?.generation ||
          "uninitialized") !== requestedControlRevision
      )
        throw new ApiError(
          409,
          "Start was stopped or superseded. Refresh before starting again.",
          "AI_START_CANCELLED",
        );
      let ctx = await tradeContext(tx, connection.id, now());
      assertRequestedAccount(executionIdentity(ctx), expectedAccount);
      if (
        !ctx.market ||
        !ctx.i?.registered_at ||
        !ctx.x ||
        now() - Number(ctx.i.last_heartbeat) > 30000 ||
        now() - Number(ctx.x.received_at) > 30000 ||
        ctx.execution?.engineVersion !== ENGINE_VERSION ||
        ctx.execution?.protocol !== 4 ||
        !ctx.execution?.terminalId
      )
        throw new ApiError(
          409,
          "Fresh verified account and current EA broker data are required.",
          "MT5_DATA_NOT_VERIFIED",
        );
      // Reading market data does not require Algo Trading, entry eligibility or
      // a broker execution policy. Execution has all those additional gates.
      if (!analysisOnly && ctx.connectionBlockers.length)
        throw new ApiError(
          409,
          ctx.connectionBlockers.join(" "),
          "MT5_PERMISSIONS_REQUIRED",
        );
      if (
        !analysisOnly &&
        ctx.i.account_type === "live" &&
        !ctx.consent.confirmed
      )
        throw new ApiError(
          403,
          "Authorize this exact Live account before enabling execution.",
          "LIVE_AUTHORIZATION_REQUIRED",
        );
      if (ctx.settings.strategy !== "adaptive") {
        await tx.query(
          "UPDATE rocket_trade_preferences SET revision=?,payload=? WHERE connection_id=?",
          [
            randomUUID(),
            JSON.stringify({ ...ctx.settings, strategy: "adaptive" }),
            connection.id,
          ],
        );
        await tx.query(
          "DELETE FROM rocket_order_previews WHERE connection_id=?",
          [connection.id],
        );
        ctx = await tradeContext(tx, connection.id, now());
      }
      requireMultiTimeframe(ctx.market);
      expectedTerminalId = ctx.execution.terminalId;
      const activation = await analysisActivationState(tx, connection.id);
      if (
        automatic &&
        (activation.paused ||
          activation.generation !== expectedActivation ||
          Number(activation.lease_until) <= now())
      )
        throw new ApiError(
          409,
          "Automatic analysis was stopped or superseded.",
          "AI_START_CANCELLED",
        );
      if (
        automatic &&
        !analysisOnly &&
        !(await executionResumeAllowed(tx, connection.id, ctx))
      )
        throw new ApiError(
          409,
          "The saved execution authorization cannot safely resume for this account and terminal.",
          "AI_START_CANCELLED",
        );
      const [active] = await tx.query(
        "SELECT state,lease_until FROM rocket_analysis_engine WHERE connection_id=?",
        [connection.id],
      );
      if (active?.state === "verifying" && Number(active.lease_until) > now())
        throw new ApiError(
          409,
          "AI Start is already in progress.",
          "AI_START_IN_PROGRESS",
        );
      if (!automatic) expectedActivation = randomUUID();
      await disableTrading(tx, connection.id, now());
      await activationState(tx, connection.id);
      await tx.query(
        "UPDATE rocket_analysis_activation SET paused=0,generation=?,mode=?,account_key=?,next_attempt=0,lease_until=?,reason=NULL WHERE connection_id=?",
        [
          expectedActivation,
          analysisOnly ? "analysis" : "execution",
          ctx.consent.key,
          now() + 90000,
          connection.id,
        ],
      );
      // Only an explicit execution Start clears the execution pause. A data
      // connection, analysis start or provider test can never grant execution.
      await tx.query(
        "UPDATE rocket_engine_activation SET paused=?,generation=?,lease_until=0,next_attempt=0,reason=? WHERE connection_id=?",
        [
          analysisOnly ? 1 : 0,
          randomUUID(),
          analysisOnly ? "Analysis only. Automated execution is OFF." : null,
          connection.id,
        ],
      );
      await tx.query(
        "INSERT INTO rocket_analysis_engine(connection_id,run_id,state,installation_id,session_id,account_key,key_revision,daily_budget_microusd,next_cycle,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,installation_id=excluded.installation_id,session_id=excluded.session_id,account_key=excluded.account_key,key_revision=excluded.key_revision,next_cycle=excluded.next_cycle,last_bar=0,lease_until=excluded.lease_until,reason=NULL",
        [
          connection.id,
          operationId,
          "verifying",
          ctx.i.id,
          ctx.x.session_id,
          ctx.consent.key,
          revisionBefore,
          Math.round(defaultDailyBudget(env) * 1e6),
          now(),
          now() + 90000,
        ],
      );
    });
    try {
      const verification = keyBefore.connection?.connected
        ? keyBefore.connection
        : await credential.test(uid);
      if (!(verification?.connected || verification?.connection?.connected))
        throw new ApiError(
          409,
          verification?.error ||
            verification?.connection?.error ||
            "OpenAI verification failed.",
          verification?.errorCode ||
            verification?.connection?.errorCode ||
            "AI_CONNECTION_REQUIRED",
        );
      if (credentialRevision(await credential.status(uid)) !== revisionBefore)
        throw new ApiError(
          409,
          "The AI credential changed during verification.",
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
        assertRequestedAccount(executionIdentity(ctx), expectedAccount);
        const activation = await analysisActivationState(tx, connection.id);
        if (
          activation.paused ||
          activation.generation !== expectedActivation ||
          !a ||
          a.run_id !== operationId ||
          a.state !== "verifying" ||
          Number(a.lease_until) <= now() ||
          a.installation_id !== ctx.i?.id ||
          a.session_id !== ctx.x?.session_id ||
          a.account_key !== ctx.consent.key ||
          ctx.execution?.terminalId !== expectedTerminalId ||
          ctx.execution?.engineVersion !== ENGINE_VERSION ||
          !ctx.market ||
          now() - Number(ctx.i?.last_heartbeat) > 30000 ||
          now() - Number(ctx.x?.received_at) > 30000
        )
          throw new ApiError(
            409,
            "Start was stopped or the verified account changed.",
            "AI_START_CANCELLED",
          );
        await tx.query(
          "UPDATE rocket_analysis_engine SET state='scheduled',lease_until=0,next_cycle=? WHERE connection_id=? AND run_id=?",
          [now(), connection.id, operationId],
        );
        if (!analysisOnly) {
          await authorizeUnifiedAutomation(
            tx,
            await tradeContext(tx, connection.id, now()),
            now(),
          );
          if (!automatic)
            await tx.query(
              "INSERT INTO rocket_execution_intent(connection_id,account_key,installation_id,terminal_id,engine_version,enabled_at) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET account_key=excluded.account_key,installation_id=excluded.installation_id,terminal_id=excluded.terminal_id,engine_version=excluded.engine_version,enabled_at=excluded.enabled_at",
              [
                connection.id,
                ctx.consent.key,
                ctx.i.id,
                ctx.execution.terminalId,
                ENGINE_VERSION,
                now(),
              ],
            );
        }
        await tx.query(
          "UPDATE rocket_analysis_activation SET lease_until=0,next_attempt=0,reason=NULL WHERE connection_id=? AND generation=?",
          [connection.id, expectedActivation],
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
      if (c) {
        await pauseActivation(tx, c.id);
        await stopAnalysis(tx, c.id, now());
      }
    });
    return status(uid);
  }
  async function autoStart(uid) {
    const [c] = await db.query(
      "SELECT id FROM rocket_direct_connections WHERE user_id=?",
      [uid],
    );
    if (!c || !(await scheduler(c.id)).configured) return status(uid);
    let generation,
      analysisOnly = true;
    try {
      generation = await db.transaction(async (tx) => {
        await tx.query(
          `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [c.id],
        );
        const a = await analysisActivationState(tx, c.id);
        if (
          a.paused ||
          Number(a.next_attempt) > now() ||
          Number(a.lease_until) > now()
        )
          return null;
        const ctx = await tradeContext(tx, c.id, now());
        // Healthy explicitly authorized execution is kept intact. Monitoring
        // and recovery never turn a revoked or switched account back ON.
        const interrupted =
          ctx.analysisEngine?.state === "running" &&
          Number(ctx.analysisEngine.lease_until) <= now();
        if (
          !interrupted &&
          ctx.analysisEngineActive &&
          (a.mode === "analysis" || ctx.permissionActive)
        )
          return null;
        if (
          ctx.analysisEngine?.state === "verifying" &&
          Number(ctx.analysisEngine.lease_until) > now()
        )
          return null;
        const executionDesired =
          a.mode === "execution" &&
          a.account_key === ctx.consent.key &&
          (await executionIntentMatches(tx, c.id, ctx));
        if (
          executionDesired &&
          !(await executionResumeAllowed(tx, c.id, ctx))
        ) {
          // Losing temporary broker/operator readiness suspends authority, not
          // the owner's persisted ON intent. Keep analysis running when it can,
          // but remove every policy until the same identity is verified again.
          const reason =
            ctx.i.account_type === "live" &&
            process.env.ROCKET_DISABLE_LIVE_ORDERS === "1"
              ? "Live execution is paused by the server operator."
              : ctx.connectionBlockers.join(" ") ||
                "A previous broker submission requires reconciliation before execution can resume.";
          await disableTrading(tx, c.id, now());
          await tx.query(
            "UPDATE rocket_analysis_activation SET reason=? WHERE connection_id=?",
            [reason, c.id],
          );
          await tx.query(
            "UPDATE rocket_analysis_engine SET reason=? WHERE connection_id=?",
            [reason, c.id],
          );
          return null;
        }
        if (
          !ctx.market ||
          !ctx.i?.registered_at ||
          !ctx.x ||
          now() - Number(ctx.i.last_heartbeat) > 30000 ||
          now() - Number(ctx.x.received_at) > 30000 ||
          ctx.execution?.engineVersion !== ENGINE_VERSION ||
          ctx.execution?.protocol !== 4 ||
          !ctx.execution?.terminalId
        ) {
          await tx.query(
            "UPDATE rocket_analysis_activation SET reason=? WHERE connection_id=?",
            ["Waiting for fresh authenticated EA market data.", c.id],
          );
          return null;
        }
        requireMultiTimeframe(ctx.market);
        if (a.mode === "execution" && ctx.unresolved) {
          await tx.query(
            "UPDATE rocket_analysis_activation SET reason=? WHERE connection_id=?",
            [
              "A previous broker submission requires reconciliation before execution can resume.",
              c.id,
            ],
          );
          return null;
        }
        analysisOnly = !executionDesired;
        const nextGeneration = randomUUID();
        await tx.query(
          "UPDATE rocket_analysis_activation SET generation=?,mode=?,account_key=?,lease_until=?,next_attempt=? WHERE connection_id=? AND paused=0",
          [
            nextGeneration,
            analysisOnly ? "analysis" : "execution",
            ctx.consent.key,
            now() + 90000,
            now() + 300000,
            c.id,
          ],
        );
        return nextGeneration;
      });
      if (generation)
        await start(uid, { automatic: true, generation, analysisOnly });
    } catch (error) {
      if (generation)
        await db.query(
          "UPDATE rocket_analysis_activation SET lease_until=0,next_attempt=?,reason=? WHERE connection_id=? AND generation=? AND paused=0",
          [
            now() + 300000,
            error instanceof ApiError
              ? error.message
              : "Automatic analysis is unavailable; execution remains disabled.",
            c.id,
            generation,
          ],
        );
    }
    return status(uid);
  }
  async function discoverStarts({ limit = 2 } = {}) {
    const rows = await db.query(
      "SELECT c.id,c.user_id FROM rocket_direct_connections c LEFT JOIN rocket_analysis_activation a ON a.connection_id=c.id LEFT JOIN rocket_engine_discovery d ON d.connection_id=c.id WHERE EXISTS (SELECT 1 FROM rocket_direct_installations i WHERE i.connection_id=c.id AND i.revoked_at IS NULL AND i.expires_at>? AND i.registered_at IS NOT NULL AND i.last_heartbeat>?) AND (a.paused IS NULL OR a.paused=0) AND (a.next_attempt IS NULL OR a.next_attempt<=?) AND (a.lease_until IS NULL OR a.lease_until<=?) ORDER BY COALESCE(d.checked_at,0),c.user_id LIMIT ?",
      [now(), now() - 30000, now(), now(), Math.max(1, Math.min(10, limit))],
    );
    for (const row of rows) {
      // Persist fair discovery across worker processes/restarts. Healthy or
      // temporarily blocked early users must not starve a later connection.
      await db.query(
        "INSERT INTO rocket_engine_discovery(connection_id,checked_at) VALUES(?,?) ON CONFLICT(connection_id) DO UPDATE SET checked_at=excluded.checked_at",
        [row.id, now()],
      );
      await autoStart(row.user_id);
    }
    return { discovered: rows.length };
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
          ctx.i &&
          ctx.x &&
          a.installation_id === ctx.i.id &&
          a.session_id === ctx.x.session_id &&
          a.account_key === ctx.consent.key &&
          ctx.execution?.engineVersion === ENGINE_VERSION &&
          (!ctx.market ||
            now() - Number(ctx.i.last_heartbeat) > 30000 ||
            now() - Number(ctx.x.received_at) > 30000)
        ) {
          await tx.query(
            "UPDATE rocket_analysis_engine SET next_cycle=?,reason=? WHERE connection_id=?",
            [
              now() + 15000,
              "Waiting for fresh authenticated broker data; new orders blocked.",
              cid,
            ],
          );
          return null;
        }
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
        return {
          ...a,
          uid: ctx.c.user_id,
          cid,
          bar,
          executionAuthorized: ctx.permissionActive,
        };
      });
      if (!job) return { state: "idle" };
      const key = keys(job.uid),
        metadata = await key.status(job.uid);
      if (credentialRevision(metadata) !== job.key_revision)
        throw new ApiError(
          409,
          "OpenAI credential changed. Restart explicitly.",
          "AI_CONFIGURATION_CHANGED",
        );
      const requestEnv = await key.environment(job.uid);
      const guard = async (tx) => {
        if (
          !credentials &&
          env.ROCKET_OPENAI_SERVER_MANAGED !== "0" &&
          credentialRevision(metadata) !== job.key_revision
        )
          throw new ApiError(
            409,
            "Server AI configuration changed; in-flight result discarded.",
            "AI_CONFIGURATION_CHANGED",
          );
        const [row] = await tx.query(
          "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
          [cid],
        );
        if (
          !row ||
          row.run_id !== job.run_id ||
          row.session_id !== job.session_id ||
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
      if (active && job.executionAuthorized)
        await automationService(db, { now }).cycle(job.installation_id);
      return { state: "scheduled" };
    } catch (error) {
      await db.transaction(async (tx) => {
        await tx.query(
          `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [cid],
        );
        const [row] = await tx.query(
          "SELECT run_id,state,session_id FROM rocket_analysis_engine WHERE connection_id=?",
          [cid],
        );
        if (
          !row ||
          row.run_id !== (job?.run_id || observedRun) ||
          (job && row.session_id !== job.session_id) ||
          row.state === "stopped" ||
          (job && row.state !== "running")
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
        await tx.query(
          "UPDATE rocket_engine_activation SET next_attempt=?,lease_until=0,reason=? WHERE connection_id=? AND paused=0",
          [now() + 300000, reason, cid],
        );
        await tx.query(
          "UPDATE rocket_analysis_activation SET next_attempt=?,lease_until=0,reason=? WHERE connection_id=? AND paused=0",
          [now() + 300000, reason, cid],
        );
      });
      return { state: "suspended" };
    }
  }
  async function drain({ limit = 2 } = {}) {
    await discoverStarts({ limit });
    const rows = await db.query(
      "SELECT connection_id FROM rocket_analysis_engine WHERE state IN ('scheduled','running') AND next_cycle<=? ORDER BY next_cycle LIMIT ?",
      [now(), Math.min(10, Math.max(1, limit))],
    );
    const results = [];
    for (const row of rows) results.push(await cycle(row.connection_id));
    return { processed: results.length };
  }
  return {
    start,
    autoStart,
    discoverStarts,
    stop,
    configure,
    status,
    scheduler,
    heartbeat,
    cycle,
    drain,
  };
}
