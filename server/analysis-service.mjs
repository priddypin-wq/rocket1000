import { randomUUID } from "node:crypto";
import { ApiError, provisioningService } from "./provisioning.mjs";
import { analyzeMarket, aiConfiguration } from "./ai-analysis.mjs";
import {
  validateSnapshot,
  requireMultiTimeframe,
  adaptiveProfile,
} from "./market.mjs";
import { tradeSettings, accountKey } from "./trade-settings.mjs";
import { markManagedPositions } from "./position-ownership.mjs";
import { runtimeAiEnvironment } from "./ai-auth.mjs";
import { selectedStrategyProfile } from "./strategy.mjs";
import { openaiCredentialService } from "./openai-credentials.mjs";
import { recentConnectionTimestamp } from "./connection-health.mjs";
export function analysisService(
  db,
  {
    now = Date.now,
    analyzer = analyzeMarket,
    resolveEnvironment,
    responder,
    beforeSnapshot,
    beforePersist,
  } = {},
) {
  const service = provisioningService(db, { now });
  async function status(uid) {
    const serverTime = now();
    const config = aiConfiguration(
      await openaiCredentialService(db, { now }).environment(uid),
    );
    let ai = {
      ...config,
      state: config.configured ? "configured" : "unconfigured",
      error: null,
      errorCode: null,
      checkedAt: null,
      lastSuccessAt: null,
    };
    const [connection] = await service.list(uid);
    if (!connection)
      return {
        serverTime,
        ai,
        accountType: null,
        latest: null,
        history: [],
        profile: null,
        market: null,
      };
    const analyses = await db.query(
      "SELECT * FROM rocket_analyses WHERE connection_id=? AND installation_id=? ORDER BY created_at DESC LIMIT 10",
      [connection.id, connection.installation?.id || ""],
    );
    const a = analyses[0];
    const [health] = await db.query(
      "SELECT * FROM rocket_ai_health WHERE connection_id=?",
      [connection.id],
    );
    if (health)
      ai = {
        ...ai,
        state: health.state,
        error: health.error,
        errorCode: health.error_code,
        checkedAt: Number(health.checked_at),
        lastSuccessAt: health.last_success_at
          ? Number(health.last_success_at)
          : null,
      };
    if (
      (ai.state === "analyzing" && serverTime - ai.checkedAt > 90000) ||
      (a?.status === "analyzing" && serverTime - Number(a.created_at) > 90000)
    )
      ai = {
        ...ai,
        state: "error",
        error:
          "The previous AI request was interrupted. Check the provider before restarting.",
        errorCode: "AI_INTERRUPTED",
      };
    const [s] = await db.query(
      "SELECT * FROM rocket_market_snapshots WHERE connection_id=?",
      [connection.id],
    );
    const valid = s && s.installation_id === connection.installation?.id;
    let market = null;
    if (valid) {
      try {
        const snapshot = validateSnapshot(
          JSON.parse(s.payload),
          Number(s.received_at),
        );
        market = {
          ...snapshot,
          receivedAt: Number(s.received_at),
          fresh:
            connection.status === "Connected" &&
            recentConnectionTimestamp(s.received_at, now()) &&
            recentConnectionTimestamp(snapshot.timestamp, now()),
        };
      } catch {
        // A malformed snapshot cannot become live data on another page.
      }
    }
    const { settings } = await tradeSettings(db, connection.id);
    const entry = (row) =>
      row
        ? {
            id: row.id,
            status:
              row.status === "analyzing" &&
              serverTime - Number(row.created_at) > 90000
                ? "error"
                : row.status,
            createdAt: Number(row.created_at),
            completedAt: row.completed_at ? Number(row.completed_at) : null,
            result: row.result ? JSON.parse(row.result) : null,
            error:
              row.status === "analyzing" &&
              serverTime - Number(row.created_at) > 90000
                ? "The previous AI request was interrupted. Retry with fresh broker data."
                : row.error,
          }
        : null;
    return {
      serverTime,
      ai,
      accountType: connection.installation?.accountType || null,
      latest: entry(a),
      history: analyses.map(entry),
      profile: market?.fresh
        ? selectedStrategyProfile(
            market,
            settings,
            adaptiveProfile(market, settings),
          )
        : null,
      market,
    };
  }
  async function start(uid) {
    const requestEnv = resolveEnvironment
      ? await resolveEnvironment(uid)
      : await runtimeAiEnvironment();
    const [c] = await service.list(uid);
    if (!c || c.status !== "Connected")
      throw new ApiError(
        409,
        "Connect the EA to your MT5 account before starting analysis.",
        "MT5_NOT_CONNECTED",
      );
    const id = randomUUID();
    const snapshot = await db.transaction(async (tx) => {
      await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [c.id],
      );
      if (beforeSnapshot) await beforeSnapshot(tx);
      const [prior] = await tx.query(
        "SELECT created_at FROM rocket_analyses WHERE connection_id=? ORDER BY created_at DESC LIMIT 1",
        [c.id],
      );
      if (prior && now() - Number(prior.created_at) < 60000)
        throw new ApiError(
          429,
          "Wait one minute before requesting another analysis.",
          "ANALYSIS_RATE_LIMITED",
        );
      const [s] = await tx.query(
        "SELECT * FROM rocket_market_snapshots WHERE connection_id=?",
        [c.id],
      );
      if (
        !s ||
        s.installation_id !== c.installation.id ||
        now() - Number(s.received_at) > 30000
      )
        throw new ApiError(
          409,
          "Waiting for fresh candles from the installed EA.",
          "MARKET_DATA_STALE",
        );
      const data = validateSnapshot(JSON.parse(s.payload), now());
      requireMultiTimeframe(data);
      await markManagedPositions(
        tx,
        c.id,
        accountKey(
          c.installation.accountLogin,
          c.installation.brokerServer,
          c.installation.accountType,
        ),
        data.positions,
      );
      const { settings, revision } = await tradeSettings(tx, c.id);
      const [execution] = await tx.query(
        "SELECT session_id,payload FROM rocket_execution WHERE connection_id=? AND installation_id=?",
        [c.id, c.installation.id],
      );
      await tx.query(
        "INSERT INTO rocket_analyses(id,connection_id,installation_id,status,created_at) VALUES(?,?,?,?,?)",
        [id, c.id, c.installation.id, "analyzing", now()],
      );
      await tx.query(
        "INSERT INTO rocket_ai_health(connection_id,state,checked_at) VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at,error_code=NULL,error=NULL",
        [c.id, "analyzing", now()],
      );
      return {
        data,
        settings,
        revision,
        execution: execution ? JSON.parse(execution.payload) : {},
        session: execution?.session_id,
        createdAt: now(),
      };
    });
    try {
      const result = {
        ...(await analyzer(snapshot.data, {
          now,
          settings: snapshot.settings,
          execution: snapshot.execution,
          managedPositions: snapshot.data.positions,
          env: requestEnv,
          ...(responder ? { responder } : {}),
        })),
        settingsRevision: snapshot.revision,
      };
      const [current] = await service.list(uid);
      if (
        current.status !== "Connected" ||
        current.installation.id !== c.installation.id ||
        current.stopped !== c.stopped
      )
        throw new ApiError(
          409,
          "Connection or safety state changed while analysis was running.",
          "ANALYSIS_CANCELLED",
        );
      await db.transaction(async (tx) => {
        if (beforePersist) await beforePersist(tx);
        const [lockedConnection] = await tx.query(
          `SELECT stopped FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [c.id],
        );
        const [activeInstallation] = await tx.query(
          "SELECT id FROM rocket_direct_installations WHERE connection_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1",
          [c.id, now()],
        );
        const currentSettings = await tradeSettings(tx, c.id);
        const [x] = await tx.query(
          "SELECT session_id FROM rocket_execution WHERE connection_id=?",
          [c.id],
        );
        const [final] = await tx.query(
          "SELECT status FROM rocket_analyses WHERE id=?",
          [id],
        );
        if (
          final?.status !== "analyzing" ||
          !lockedConnection ||
          !!lockedConnection.stopped !== c.stopped ||
          activeInstallation?.id !== c.installation.id ||
          currentSettings.revision !== snapshot.revision ||
          x?.session_id !== snapshot.session
        )
          throw new ApiError(
            409,
            "Account session, risk settings or safety state changed. Analysis cancelled.",
            "ANALYSIS_CANCELLED",
          );
        await tx.query(
          "UPDATE rocket_analyses SET status=?,result=?,completed_at=? WHERE id=? AND status=?",
          ["completed", JSON.stringify(result), now(), id, "analyzing"],
        );
        await tx.query(
          "UPDATE rocket_ai_health SET state='connected',checked_at=?,last_success_at=?,error_code=NULL,error=NULL WHERE connection_id=? AND checked_at=?",
          [now(), now(), c.id, snapshot.createdAt],
        );
      });
      return { id, ...result };
    } catch (e) {
      await db.query(
        "UPDATE rocket_analyses SET status=?,error=?,completed_at=? WHERE id=? AND status=?",
        [
          "error",
          e instanceof ApiError ? e.message : "Analysis failed",
          now(),
          id,
          "analyzing",
        ],
      );
      await db.query(
        "UPDATE rocket_ai_health SET state='error',checked_at=?,error_code=?,error=? WHERE connection_id=? AND checked_at=?",
        [
          now(),
          e instanceof ApiError ? e.code : "AI_UNAVAILABLE",
          e instanceof ApiError ? e.message : "Analysis failed",
          c.id,
          snapshot.createdAt,
        ],
      );
      throw e;
    }
  }
  return { status, start };
}
