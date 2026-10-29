import { tradeContext } from "./trading.mjs";
import { engineService } from "./engine-service.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { isConfiguredModel } from "./ai-provider.mjs";
import { decisionBar } from "./market.mjs";

// A read-only dashboard projection of the one OpenAI engine, never a second
// trading worker. Only authenticated broker facts and saved model output appear.
export function autonomousStatusService(db, { now = Date.now } = {}) {
  async function status(uid) {
    const engine = await engineService(db, { now }).status(uid);
    return db.transaction(async (tx) => {
      const [c] = await tx.query(
        "SELECT id FROM rocket_direct_connections WHERE user_id=?",
        [uid],
      );
      const empty = {
        state: "waiting",
        enabled: false,
        account: null,
        direction: null,
        regime: null,
        currentScalp: null,
        dailyPnl: null,
        completedScalps: null,
        lastDecision: null,
        risk: {
          perTradePct: 0.25,
          aggregatePct: 0.25,
          maxPositions: 1,
          dailyLossPct: 1,
          consecutiveLosses: null,
          blocked: true,
          reasons: ["Connect the authenticated EA."],
        },
        metrics: null,
        engine,
      };
      if (!c) return empty;
      const ctx = await tradeContext(tx, c.id, now());
      const [a] = await tx.query(
        "SELECT result FROM rocket_analyses WHERE connection_id=? AND installation_id=? AND status='completed' ORDER BY created_at DESC LIMIT 1",
        [c.id, ctx.i?.id || ""],
      );
      const result = a?.result ? JSON.parse(a.result) : null;
      const fresh = !!(ctx.market && !ctx.connectionBlockers.length);
      const verifiedDecision =
        fresh &&
        result &&
        result.engineVersion === ENGINE_VERSION &&
        result.settingsRevision === ctx.revision &&
        isConfiguredModel(result.model, ctx.aiModel) &&
        result.symbol === ctx.market?.symbol &&
        result.profile?.decisionBarTime === decisionBar(ctx.market) &&
        result.expiresAt > now()
          ? result
          : null;
      const positions = ctx.market?.positions.filter((p) => p.managed) || [];
      const p = positions[0];
      const account = ctx.i?.registered_at
        ? {
            login: ctx.i.account_login,
            server: ctx.i.broker_server,
            type: ctx.i.account_type,
          }
        : null;
      const historyKnown =
        fresh && ctx.execution?.tradeHistory?.available === true;
      const owned = historyKnown
        ? await tx.query(
            "SELECT identifier,payload FROM rocket_owned_positions WHERE connection_id=? AND account_key=? AND verification_state='closed'",
            [c.id, ctx.consent.key],
          )
        : [];
      const deals = historyKnown
        ? (
            await tx.query(
              "SELECT payload FROM rocket_broker_deals WHERE connection_id=? AND account_key=? ORDER BY broker_time",
              [c.id, ctx.consent.key],
            )
          ).map((r) => JSON.parse(r.payload))
        : [];
      const samples = owned
        .map((r) => {
          const ds = deals.filter((d) => d.positionIdentifier === r.identifier);
          return ds.some((d) => d.entry === "IN") &&
            ds.some((d) => ["OUT", "OUT_BY"].includes(d.entry))
            ? ds.reduce(
                (sum, d) => sum + d.profit + d.commission + d.swap + d.fee,
                0,
              )
            : null;
        })
        .filter(Number.isFinite);
      const wins = samples.filter((v) => v > 0),
        losses = samples.filter((v) => v < 0);
      const direction = fresh
        ? ctx.profile?.frames?.M5?.trend?.direction
        : null;
      return {
        ...empty,
        state:
          !account || !ctx.market
            ? "waiting"
            : engine.state === "stopped"
              ? "paused"
              : ctx.blockers.length || engine.state === "suspended"
                ? "blocked"
                : "monitoring",
        enabled: ctx.permissionActive && engine.executionAuthorized,
        account,
        direction:
          direction === "up"
            ? "bullish"
            : direction === "down"
              ? "bearish"
              : direction
                ? "neutral"
                : null,
        regime: fresh ? ctx.profile?.regime || null : null,
        activeStrategy: verifiedDecision?.strategy || "wait",
        currentScalp: p
          ? {
              ticket: p.ticket,
              symbol: p.symbol,
              side: p.side,
              entry: p.open,
              stop: p.stop,
              takeProfit: p.takeProfit,
              currentPrice:
                p.currentPrice ??
                (p.symbol === ctx.market.symbol
                  ? p.side === "BUY"
                    ? ctx.market.bid
                    : ctx.market.ask
                  : null),
              volume: p.volume,
              profit: p.profit,
            }
          : null,
        dailyPnl:
          fresh && Number.isFinite(ctx.execution?.account?.dailyProfitLoss)
            ? ctx.execution.account.dailyProfitLoss
            : null,
        completedScalps: historyKnown ? samples.length : null,
        risk: {
          perTradePct: ctx.settings.riskPerTradePct,
          aggregatePct: ctx.settings.maxAggregateRiskPct ?? 0.25,
          maxPositions: 1,
          dailyLossPct: ctx.settings.maxDailyLossPct,
          consecutiveLosses: ctx.execution?.consecutiveLossesVerified
            ? ctx.execution.consecutiveLosses
            : null,
          blocked: !fresh || !!ctx.blockers.length,
          reasons: ctx.blockers,
        },
        lastDecision: verifiedDecision
          ? {
              decision: verifiedDecision.decision,
              reasoning: verifiedDecision.reasoning,
              barTime: verifiedDecision.profile?.decisionBarTime,
            }
          : null,
        lastError: engine.reason || ctx.automation?.last_error || null,
        metrics: historyKnown
          ? {
              scope:
                "Observed, fully broker-reconciled Rocket1000 positions; not a backtest",
              trades: samples.length,
              winRate: samples.length ? wins.length / samples.length : null,
              profitFactor: losses.length
                ? wins.reduce((s, v) => s + v, 0) /
                  -losses.reduce((s, v) => s + v, 0)
                : null,
              averageProfit: wins.length
                ? wins.reduce((s, v) => s + v, 0) / wins.length
                : null,
              averageLoss: losses.length
                ? losses.reduce((s, v) => s + v, 0) / losses.length
                : null,
              netExpectancy: samples.length
                ? samples.reduce((s, v) => s + v, 0) / samples.length
                : null,
              maximumDrawdown: null,
              reversalPerformance: null,
              riskViolations: null,
            }
          : null,
      };
    });
  }
  return { status };
}
