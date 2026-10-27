import { analysisService } from "./analysis-service.mjs";
import { analyzeMarket, MODEL } from "./ai-analysis.mjs";
import { isConfiguredModel } from "./ai-provider.mjs";
import { ApiError } from "./errors.mjs";
import { tradeContext, enqueueCommand, disableTrading } from "./trading.mjs";
import { decisionBar } from "./market.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { selectedStrategyProfile } from "./strategy.mjs";

export function automaticIntent(ctx, decision) {
  const { market: m, execution: e, settings: s } = ctx;
  const positions = m.positions.filter(
    (p) => p.managed && p.symbol === m.symbol,
  );
  const profile = ctx.profile
    ? selectedStrategyProfile(m, s, ctx.profile, e)
    : null;
  const signal =
    decision &&
    isConfiguredModel(decision.model, ctx.aiModel || MODEL) &&
    decision.engineVersion === ENGINE_VERSION &&
    decision.expiresAt > ctx.now &&
    decision.settingsRevision === ctx.revision &&
    decision.symbol === m.symbol &&
    ["BUY", "SELL", "WAIT"].includes(decision.decision) &&
    Array.isArray(decision.positionActions) &&
    Number.isFinite(decision.confidence) &&
    decision.confidence >= (profile?.minConfidence || s.minConfidence);
  if (!signal) return null;
  // Position changes must be explicit AI proposals. A price threshold or an
  // opposite direction alone cannot manufacture a strategy command.
  for (const action of decision.positionActions) {
    const p = positions.find((p) => p.ticket === action.position);
    if (!p) continue;
    if (action.kind === "CLOSE") return { kind: "CLOSE", position: p.ticket };
    if (
      action.kind === "PARTIAL_CLOSE" &&
      action.volume > 0 &&
      action.volume < p.volume
    )
      return {
        kind: "CLOSE",
        position: p.ticket,
        volume: action.volume,
        partialClose: true,
      };
    if (
      action.kind === "MODIFY" &&
      action.stopLoss > 0 &&
      action.takeProfit > 0 &&
      (Math.abs(action.stopLoss - p.stop) >= e.tickSize / 2 ||
        Math.abs(action.takeProfit - p.takeProfit) >= e.tickSize / 2)
    )
      return {
        kind: "MODIFY",
        position: p.ticket,
        stop: action.stopLoss,
        takeProfit: action.takeProfit,
      };
  }
  if (
    !["BUY", "SELL"].includes(decision.decision) ||
    m.positions.length ||
    decision.entryAction !== "OPEN" ||
    !Number.isFinite(decision.proposedLots) ||
    decision.proposedLots <= 0 ||
    !ctx.enabled ||
    !profile?.ready ||
    !profile.allowedStrategies.includes(decision.strategy)
  )
    return null;
  const side = decision.decision,
    entry = side === "BUY" ? m.ask : m.bid;
  if (
    ![decision.entryPrice, decision.stopLoss, decision.takeProfit].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    Math.abs(entry - decision.entryPrice) > s.maxSlippagePoints * e.point
  )
    return null;
  const stop =
    side === "BUY"
      ? Math.floor(decision.stopLoss / e.tickSize) * e.tickSize
      : Math.ceil(decision.stopLoss / e.tickSize) * e.tickSize;
  const takeProfit =
    side === "BUY"
      ? Math.ceil(decision.takeProfit / e.tickSize) * e.tickSize
      : Math.floor(decision.takeProfit / e.tickSize) * e.tickSize;
  if (
    (side === "BUY"
      ? !(stop < m.bid && takeProfit > m.ask)
      : !(stop > m.ask && takeProfit < m.bid)) ||
    Math.abs(entry - stop) + 1e-8 <
      Math.max(0, e.stopLevel + 2, (e.freezeLevel || 0) + 2) * e.point ||
    Math.abs(entry - takeProfit) + 1e-8 <
      Math.max(0, e.stopLevel + 2, (e.freezeLevel || 0) + 2) * e.point ||
    Math.abs(entry - takeProfit) / Math.abs(entry - stop) + 1e-8 <
      ctx.profile.minRewardRisk
  )
    return null;
  return {
    kind: "OPEN",
    side,
    symbol: m.symbol,
    stop: Number(stop.toFixed(10)),
    takeProfit: Number(takeProfit.toFixed(10)),
    maxLots: Math.min(
      decision.proposedLots,
      s.sizingMode === "capped" ? s.lotSize : e.maxVolume,
    ),
  };
}

export function automationService(
  db,
  { now = Date.now, analyzer = analyzeMarket } = {},
) {
  async function cycle(installationId) {
    const [i] = await db.query(
      "SELECT connection_id FROM rocket_direct_installations WHERE id=?",
      [installationId],
    );
    if (!i) return { state: "stopped" };
    let job, observedRun;
    try {
      job = await db.transaction(async (tx) => {
        const ctx = await tradeContext(tx, i.connection_id, now()),
          a = ctx.automation;
        if (
          !a ||
          a.state !== "running" ||
          a.installation_id !== installationId ||
          (analyzer === analyzeMarket && !ctx.analysisEngineActive) ||
          ctx.execution.protocol !== 4
        )
          return { state: "stopped" };
        observedRun = { runId: a.run_id, cid: ctx.c.id, session: a.session_id };
        if (ctx.execution.engineVersion !== ENGINE_VERSION) {
          await disableTrading(tx, ctx.c.id, now());
          await tx.query(
            "UPDATE rocket_automation SET last_error=? WHERE connection_id=?",
            [
              "Install ROCKET1000 EA 7.00 and verify the current engine before restarting automatic trading.",
              ctx.c.id,
            ],
          );
          return { state: "stopped" };
        }
        if (!ctx.permissionActive) return { state: "stopped" };
        const m = ctx.market,
          e = ctx.execution,
          s = ctx.settings,
          bar = decisionBar(m);
        if (
          Math.max(e.dailyLoss, e.dayStartEquity - m.equity) >=
            (e.dayStartEquity * s.maxDailyLossPct) / 100 ||
          (e.peakEquity - m.equity) / e.peakEquity >= s.maxDrawdownPct / 100
        ) {
          await disableTrading(tx, ctx.c.id, now());
          await tx.query(
            "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
            [ctx.c.id],
          );
          await tx.query(
            "UPDATE rocket_automation SET last_error=? WHERE connection_id=?",
            [
              "Daily loss or drawdown limit reached. New trades stopped; broker protective stops remain in place.",
              ctx.c.id,
            ],
          );
          return { state: "risk-stopped" };
        }
        const [pending] = await tx.query(
          "SELECT t.id FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.connection_id=? AND a.account_key=? AND t.status IN ('queued','claimed','sending','uncertain') LIMIT 1",
          [ctx.c.id, ctx.consent.key],
        );
        if (pending) return { state: "awaiting-broker" };
        const [saved] = await tx.query(
          "SELECT result FROM rocket_auto_decisions WHERE connection_id=? AND run_id=? AND bar_time=?",
          [ctx.c.id, a.run_id, bar],
        );
        let decision = saved ? JSON.parse(saved.result) : null;
        if (!decision && analyzer === analyzeMarket) {
          const [latest] = await tx.query(
            "SELECT id,result FROM rocket_analyses WHERE connection_id=? AND installation_id=? AND status='completed' ORDER BY created_at DESC LIMIT 1",
            [ctx.c.id, installationId],
          );
          const result = latest?.result
            ? { ...JSON.parse(latest.result), id: latest.id }
            : null;
          if (
            result &&
            result.expiresAt > now() &&
            result.settingsRevision === ctx.revision &&
            result.engineVersion === ENGINE_VERSION &&
            result.symbol === ctx.market.symbol &&
            result.profile?.decisionBarTime === bar &&
            isConfiguredModel(result.model, ctx.aiModel)
          ) {
            decision = result;
            await tx.query(
              "INSERT INTO rocket_auto_decisions(connection_id,run_id,bar_time,result,created_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,run_id,bar_time) DO NOTHING",
              [ctx.c.id, a.run_id, bar, JSON.stringify(result), now()],
            );
          }
          if (!decision) return { state: "waiting-analysis-worker" };
        }
        const due =
          !decision &&
          bar !== Number(a.last_bar) &&
          now() - Number(a.last_cycle) >= s.intervalSeconds * 1000;
        if (!due || Number(a.lease_until) > now()) {
          const intent = automaticIntent(ctx, decision);
          if (
            intent &&
            (intent.kind !== "OPEN" || Number(a.last_action_bar) !== bar)
          ) {
            const key = `auto:${a.run_id}:${bar}:${intent.kind}:${intent.position || ""}:${intent.kind === "MODIFY" ? intent.stop : ""}`;
            const command = await enqueueCommand(tx, ctx, intent, key, now(), {
              analysisId: decision?.expiresAt > now() ? decision.id : undefined,
            });
            if (intent.kind !== "MODIFY")
              await tx.query(
                "UPDATE rocket_automation SET last_action_bar=? WHERE connection_id=?",
                [bar, ctx.c.id],
              );
            return { state: "queued", ...command };
          }
          if (
            bar === Number(a.last_bar) &&
            !saved &&
            Number(a.lease_until) <= now()
          ) {
            await disableTrading(tx, ctx.c.id, now());
            await tx.query(
              "UPDATE rocket_automation SET last_error=? WHERE connection_id=?",
              [
                "AI analysis was interrupted. Restart after checking the provider; no order was retried.",
                ctx.c.id,
              ],
            );
            return { state: "interrupted" };
          }
          return { state: decision ? "waiting-next-candle" : "analyzing" };
        }
        // A blocked entry never spends model credits just to pretend to be trading.
        if (
          ctx.blockers.length &&
          !m.positions.some((p) => p.managed && p.symbol === m.symbol)
        ) {
          await tx.query(
            "UPDATE rocket_automation SET last_error=? WHERE connection_id=?",
            [ctx.blockers.join(" ").slice(0, 1500), ctx.c.id],
          );
          return { state: "waiting-safety" };
        }
        let suppliedResult = null;
        if (analyzer === analyzeMarket) {
          // Production only consumes the durable worker's budgeted assessment.
          // EA heartbeats never launch a second, unmetered provider request.
          const [completed] = await tx.query(
            "SELECT id,result FROM rocket_analyses WHERE connection_id=? AND installation_id=? AND status='completed' ORDER BY created_at DESC LIMIT 1",
            [ctx.c.id, installationId],
          );
          const latest = completed?.result
            ? JSON.parse(completed.result)
            : null;
          if (
            !latest ||
            latest.expiresAt <= now() ||
            latest.settingsRevision !== ctx.revision ||
            latest.profile?.decisionBarTime !== bar ||
            latest.symbol !== m.symbol ||
            !isConfiguredModel(latest.model, ctx.aiModel || MODEL)
          )
            return { state: "waiting-budgeted-analysis" };
          suppliedResult = { ...latest, id: completed.id };
        } else {
          // Explicit injected test analyzers exercise deterministic execution
          // fixtures; the production constructor never enters this branch.
          const [recentAnalysis] = await tx.query(
            "SELECT created_at FROM rocket_analyses WHERE connection_id=? ORDER BY created_at DESC LIMIT 1",
            [ctx.c.id],
          );
          if (
            recentAnalysis &&
            now() - Number(recentAnalysis.created_at) < 60000
          )
            return { state: "waiting-analysis-interval" };
        }
        const leaseUntil = now() + 90000;
        await tx.query(
          "UPDATE rocket_automation SET last_cycle=?,last_bar=?,lease_until=?,last_error=NULL WHERE connection_id=?",
          [now(), bar, leaseUntil, ctx.c.id],
        );
        return {
          state: "analyze",
          uid: ctx.c.user_id,
          cid: ctx.c.id,
          runId: a.run_id,
          bar,
          session: ctx.x.session_id,
          leaseUntil,
          accountKey: ctx.consent.key,
          suppliedResult,
        };
      });
      if (job.state !== "analyze") return job;
      const result =
        job.suppliedResult ||
        (await analysisService(db, { now, analyzer }).start(job.uid));
      return await db.transaction(async (tx) => {
        const ctx = await tradeContext(tx, job.cid, now()),
          a = ctx.automation;
        if (
          !a ||
          a.run_id !== job.runId ||
          a.state !== "running" ||
          !ctx.permissionActive ||
          ctx.x.session_id !== job.session ||
          ctx.consent.key !== job.accountKey
        )
          return { state: "discarded" };
        if (decisionBar(ctx.market) !== job.bar) {
          await tx.query(
            "UPDATE rocket_automation SET lease_until=0 WHERE connection_id=? AND run_id=?",
            [job.cid, job.runId],
          );
          return { state: "discarded" };
        }
        if (
          !isConfiguredModel(result.model, ctx.aiModel || MODEL) ||
          result.engineVersion !== ENGINE_VERSION ||
          result.settingsRevision !== ctx.revision ||
          result.symbol !== ctx.market.symbol ||
          !["BUY", "SELL", "WAIT"].includes(result.decision) ||
          !Number.isFinite(result.confidence) ||
          result.confidence < 0 ||
          result.confidence > 1
        )
          throw new ApiError(502, "Invalid automated model assessment.");
        await tx.query(
          "INSERT INTO rocket_auto_decisions(connection_id,run_id,bar_time,result,created_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,run_id,bar_time) DO NOTHING",
          [job.cid, job.runId, job.bar, JSON.stringify(result), now()],
        );
        await tx.query(
          "UPDATE rocket_automation SET lease_until=0,last_error=NULL WHERE connection_id=?",
          [job.cid],
        );
        const [pending] = await tx.query(
          "SELECT t.id FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.connection_id=? AND a.account_key=? AND t.status IN ('queued','claimed','sending','uncertain') LIMIT 1",
          [job.cid, job.accountKey],
        );
        if (pending) return { state: "awaiting-broker" };
        const intent = automaticIntent(ctx, result);
        if (
          !intent ||
          (intent.kind === "OPEN" && Number(a.last_action_bar) === job.bar)
        )
          return { state: "waiting", decision: result.decision };
        const command = await enqueueCommand(
          tx,
          ctx,
          intent,
          `auto:${job.runId}:${job.bar}:${intent.kind}:${intent.position || ""}:${intent.kind === "MODIFY" ? intent.stop : ""}`,
          now(),
          { analysisId: result.id },
        );
        if (intent.kind !== "MODIFY")
          await tx.query(
            "UPDATE rocket_automation SET last_action_bar=? WHERE connection_id=?",
            [job.bar, job.cid],
          );
        return { state: "queued", ...command };
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "TRADING_COOLDOWN")
        return { state: "waiting-cooldown" };
      const runIdentity = job?.runId ? job : observedRun;
      if (runIdentity?.runId)
        await db.transaction(async (tx) => {
          await tx.query(
            `SELECT id FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
            [i.connection_id],
          );
          const [a] = await tx.query(
            "SELECT run_id,session_id,state,lease_until FROM rocket_automation WHERE connection_id=?",
            [i.connection_id],
          );
          if (
            a?.run_id === runIdentity.runId &&
            a.session_id === runIdentity.session &&
            a.state === "running" &&
            (!job?.runId || Number(a.lease_until) === job.leaseUntil)
          ) {
            await disableTrading(tx, i.connection_id, now());
            await tx.query(
              "UPDATE rocket_automation SET last_error=? WHERE connection_id=?",
              [
                error instanceof ApiError
                  ? error.message
                  : "Automatic trading paused because the analysis service failed.",
                i.connection_id,
              ],
            );
          }
        });
      return { state: "error" };
    }
  }
  return { cycle };
}
