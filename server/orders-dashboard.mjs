import { accountKey } from "./trade-settings.mjs";
import {
  markManagedPositions,
  hasManagedOrigin,
} from "./position-ownership.mjs";
import {
  tradingService,
  validateExecution,
  tradeContext,
  orderRisk,
} from "./trading.mjs";
import { validateSnapshot, decisionBar, sanitizePositions } from "./market.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { MODEL, validateAssessment } from "./ai-analysis.mjs";
import { selectedStrategyProfile } from "./strategy.mjs";

// Called only after credential/account validation, inside the telemetry lock.
export async function synchronizeOwnedBrokerState(tx, i, input, now) {
  if (!input.execution) return;
  const x = validateExecution({
    ...input.execution,
    protocol: input.eaProtocol,
  });
  const key = accountKey(
    input.accountLogin,
    input.brokerServer,
    input.accountType,
  );
  const account = {
    login: input.accountLogin,
    server: input.brokerServer,
    type: input.accountType,
    currency: x.account?.currency ?? input.market?.currency ?? null,
  };
  const positions =
    x.positions ||
    (input.market ? sanitizePositions(input.market.positions) : undefined);
  const authoritative =
    x.positions !== undefined ? x.positionsAvailable === true : !!input.market;
  if (positions) {
    await markManagedPositions(tx, i.connection_id, key, positions);
    if (authoritative) {
      // Absence is not a fabricated broker fill. Keep it visible until a broker
      // exit deal proves closure, or a later complete snapshot restores it.
      await tx.query(
        "UPDATE rocket_owned_positions SET verification_state='missing' WHERE connection_id=? AND account_key=? AND verification_state!='closed'",
        [i.connection_id, key],
      );
    }
    for (const p of positions.filter((p) => p.managed)) {
      const payload = {
        ...p,
        account,
        observedBrokerAt:
          p.execution?.brokerTimestamp ||
          input.market?.brokerTimestamp ||
          x.tradeHistory?.to ||
          null,
      };
      await tx.query(
        "INSERT INTO rocket_owned_positions(connection_id,account_key,identifier,payload,verification_state,received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id,account_key,identifier) DO UPDATE SET payload=excluded.payload,verification_state=excluded.verification_state,received_at=excluded.received_at",
        [
          i.connection_id,
          key,
          p.identifier,
          JSON.stringify(payload),
          authoritative ? "open" : "attention",
          now,
        ],
      );
    }
  }
  if (x.tradeHistory?.available) {
    for (const d of x.tradeHistory.deals) {
      if (!(await hasManagedOrigin(tx, i.connection_id, key, d))) continue;
      await tx.query(
        "INSERT INTO rocket_broker_deals(connection_id,account_key,ticket,payload,broker_time,received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id,account_key,ticket) DO NOTHING",
        [i.connection_id, key, d.ticket, JSON.stringify(d), d.time, now],
      );
    }
  }
  if (authoritative) {
    const missing = await tx.query(
      "SELECT identifier,payload FROM rocket_owned_positions WHERE connection_id=? AND account_key=? AND verification_state='missing'",
      [i.connection_id, key],
    );
    const deals = (
      await tx.query(
        "SELECT payload FROM rocket_broker_deals WHERE connection_id=? AND account_key=?",
        [i.connection_id, key],
      )
    ).map((r) => JSON.parse(r.payload));
    for (const p of missing) {
      const prior = JSON.parse(p.payload),
        lineage = deals.filter((d) => d.positionIdentifier === p.identifier);
      const entries = lineage
        .filter((d) => d.entry === "IN")
        .reduce((n, d) => n + d.volume, 0);
      const exits = lineage.filter((d) => ["OUT", "OUT_BY"].includes(d.entry));
      const out = exits.reduce((n, d) => n + d.volume, 0);
      const recentOut = exits
        .filter(
          (d) => prior.observedBrokerAt && d.time > prior.observedBrokerAt,
        )
        .reduce((n, d) => n + d.volume, 0);
      if (
        (entries > 0 && out + 1e-8 >= entries) ||
        recentOut + 1e-8 >= prior.volume
      )
        await tx.query(
          "UPDATE rocket_owned_positions SET verification_state='closed' WHERE connection_id=? AND account_key=? AND identifier=?",
          [i.connection_id, key, p.identifier],
        );
    }
  }
}

export function ordersDashboardService(db, { now = Date.now } = {}) {
  async function status(uid) {
    const [c] = await db.query(
      "SELECT * FROM rocket_direct_connections WHERE user_id=?",
      [uid],
    );
    if (!c)
      return {
        serverTime: now(),
        connection: {
          status: "Disconnected",
          fresh: false,
          lastHeartbeat: null,
        },
        account: null,
        accountKey: null,
        authorizedSymbols: [],
        positions: [],
        opportunities: [],
        latestSignal: null,
        brokerPending: [],
        history: [],
        performance: { available: false },
        ai: { state: "unavailable" },
        automation: null,
        risk: null,
        blockers: [
          "Connect your Rocket1000 EA to see trading symbols and orders.",
        ],
        permissionActive: false,
        liveConfirmed: false,
      };
    const trading = await tradingService(db, { now }).status(uid);
    return db.transaction(async (tx) => {
      const [i] = await tx.query(
        "SELECT * FROM rocket_direct_installations WHERE connection_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
        [c.id],
      );
      const [e] = await tx.query(
        "SELECT * FROM rocket_execution WHERE connection_id=?",
        [c.id],
      );
      const [registration] = await tx.query(
        "SELECT * FROM rocket_ea_symbols WHERE connection_id=?",
        [c.id],
      );
      const [marketRow] = await tx.query(
        "SELECT * FROM rocket_market_snapshots WHERE connection_id=?",
        [c.id],
      );
      const key = accountKey(
        c.expected_login,
        c.expected_server,
        c.expected_type,
      );
      const identity =
        i?.registered_at &&
        i.account_login === c.expected_login &&
        i.broker_server === c.expected_server &&
        i.account_type === c.expected_type;
      const fresh = !!(
        identity &&
        !i.last_error &&
        Number(i.expires_at) > now() &&
        i.last_heartbeat &&
        now() - Number(i.last_heartbeat) <= 30000 &&
        e?.installation_id === i.id &&
        now() - Number(e.received_at) <= 30000
      );
      let execution = null,
        market = null;
      try {
        if (e?.installation_id === i?.id)
          execution = validateExecution(JSON.parse(e.payload));
      } catch {
        /* Never display malformed broker telemetry. */
      }
      try {
        if (
          marketRow?.installation_id === i?.id &&
          now() - Number(marketRow.received_at) <= 30000
        )
          market = validateSnapshot(JSON.parse(marketRow.payload), now());
      } catch {
        /* No fresh quote means no advertised broker prices. */
      }
      const registered =
        fresh &&
        registration?.installation_id === i?.id &&
        registration.session_id === e?.session_id &&
        registration.account_key === key;
      const symbolFresh = !!(
        registered && market?.symbol === registration.symbol
      );
      const account = identity
        ? {
            login: i.account_login,
            server: i.broker_server,
            type: i.account_type,
            balance: fresh
              ? (execution?.account?.balance ?? market?.balance ?? null)
              : null,
            equity: fresh
              ? (execution?.account?.equity ?? market?.equity ?? null)
              : null,
            currency: execution?.account?.currency ?? market?.currency ?? null,
            brokerName: execution?.account?.brokerName ?? null,
            dailyProfitLoss: fresh
              ? (execution?.account?.dailyProfitLoss ?? null)
              : null,
          }
        : null;
      const stored = await tx.query(
        "SELECT * FROM rocket_owned_positions WHERE connection_id=? AND verification_state!='closed' ORDER BY received_at DESC",
        [c.id],
      );
      const positions = stored.map((row) => {
        const p = JSON.parse(row.payload),
          currentAccount = row.account_key === key;
        const positionFresh =
          fresh &&
          currentAccount &&
          row.verification_state === "open" &&
          now() - Number(row.received_at) <= 30000;
        const onChart = registration?.symbol === p.symbol;
        const q = p.execution;
        const oldSymbolCloseSafe =
          q &&
          q.tradeAllowed &&
          q.sessionOpen !== false &&
          q.symbolTradeMode !== 0 &&
          (q.orderMode === undefined || !!(q.orderMode & 1)) &&
          Math.abs(now() - q.timestamp) <= 30000 &&
          Math.abs(q.brokerTimestamp - q.timestamp) <= 86400000 &&
          q.brokerTimestamp - q.quoteTimestamp <= 15000 &&
          q.quoteTimestamp - q.brokerTimestamp <= 2000;
        return {
          ...p,
          execution: undefined,
          observedBrokerAt: undefined,
          currentPrice:
            p.currentPrice ??
            (onChart && market
              ? p.side === "BUY"
                ? market.bid
                : market.ask
              : null),
          openedAt: p.openedAt ?? null,
          status: positionFresh && onChart ? "Open" : "Requires attention",
          fresh: positionFresh,
          receivedAt: Number(row.received_at),
          canClose: !!(
            positionFresh &&
            trading.permissionActive &&
            !trading.connectionBlockers.length &&
            !trading.brokerOutcomePending &&
            (onChart
              ? execution?.sessionOpen !== false &&
                execution?.symbolTradeMode !== 0 &&
                (execution?.orderMode === undefined ||
                  !!(execution.orderMode & 1))
              : oldSymbolCloseSafe)
          ),
        };
      });
      const history = (
        await tx.query(
          "SELECT payload FROM rocket_broker_deals WHERE connection_id=? AND account_key=? ORDER BY broker_time DESC LIMIT 100",
          [c.id, key],
        )
      ).map((r) => {
        const d = JSON.parse(r.payload);
        const safe = { ...d };
        for (const name of [
          "originComment",
          "ownedIntegrity",
          "magic",
          "comment",
        ])
          delete safe[name];
        return safe;
      });
      // Metrics refer only to the exact authenticated, backend-owned deal sample
      // displayed below. A matching magic number from another installation is
      // never enough to contribute fabricated ownership or performance.
      const exits = history.filter((d) => ["OUT", "OUT_BY"].includes(d.entry));
      const net = (d) => d.profit + d.commission + d.swap + d.fee;
      const performance =
        fresh && history.length
          ? {
              available: true,
              complete: false,
              scope: "Verified broker deals shown (up to 100)",
              from: Math.min(...history.map((d) => d.time)),
              to: Math.max(...history.map((d) => d.time)),
              currency:
                execution?.account?.currency ??
                execution?.tradeHistory?.currency ??
                null,
              closedDeals: exits.length,
              wins: exits.filter((d) => net(d) > 0).length,
              losses: exits.filter((d) => net(d) < 0).length,
              grossProfit: history.reduce((n, d) => n + Math.max(0, net(d)), 0),
              grossLoss: history.reduce((n, d) => n + Math.max(0, -net(d)), 0),
              netProfit: history.reduce((n, d) => n + net(d), 0),
            }
          : { available: false };
      const brokerPending = [];
      if (fresh && execution?.brokerPendingAvailable && execution.brokerPending)
        for (const p of execution.brokerPending)
          if (
            await hasManagedOrigin(tx, c.id, key, {
              ...p,
              positionIdentifier: p.ticket,
            })
          )
            brokerPending.push({
              ticket: p.ticket,
              symbol: p.symbol,
              side: p.side,
              volume: p.volume,
              price: p.price,
              stop: p.stop,
              takeProfit: p.takeProfit,
              createdAt: p.createdAt,
              status: "Broker pending",
            });
      const [analysis] = await tx.query(
        "SELECT * FROM rocket_analyses WHERE connection_id=? AND installation_id=? AND status='completed' AND result IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [c.id, i?.id || ""],
      );
      const opportunities = [];
      let latestSignal = null;
      if (symbolFresh && analysis) {
        const a = JSON.parse(analysis.result);
        let valid = false;
        try {
          validateAssessment(
            Object.fromEntries(
              [
                "decision",
                "confidence",
                "strategy",
                "timeframe",
                "entryPrice",
                "stopLoss",
                "takeProfit",
                "reasoning",
                "risks",
              ].map((k) => [k, a[k]]),
            ),
            market,
            selectedStrategyProfile(
              market,
              trading.settings,
              trading.profile,
              execution,
            ),
          );
          valid = true;
        } catch {
          /* Old or invalid model output is never a current opportunity. */
        }
        if (
          valid &&
          a.engineVersion === ENGINE_VERSION &&
          a.model === MODEL &&
          a.settingsRevision === trading.settingsRevision &&
          a.symbol === market.symbol &&
          a.expiresAt > now() &&
          a.marketTimestamp <= market.timestamp &&
          a.profile?.decisionBarTime === decisionBar(market) &&
          ["BUY", "SELL", "WAIT"].includes(a.decision)
        )
          latestSignal = {
            id: analysis.id,
            symbol: a.symbol,
            decision: a.decision,
            strategy: a.strategy,
            reasoning: a.reasoning,
            analyzedAt: a.analyzedAt,
            expiresAt: a.expiresAt,
          };
        if (
          latestSignal &&
          Number.isFinite(a.proposedLots) &&
          a.proposedLots > 0 &&
          ["OPEN", "ADD"].includes(a.entryAction) &&
          ["BUY", "SELL"].includes(a.decision) &&
          a.confidence >=
            (trading.profile?.minConfidence || trading.settings.minConfidence)
        ) {
          const [command] = (
            await tx.query(
              "SELECT t.status,t.payload FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.connection_id=? AND a.account_key=? ORDER BY t.created_at DESC LIMIT 100",
              [c.id, key],
            )
          ).filter((row) => JSON.parse(row.payload).analysisId === analysis.id);
          let proposalStatus = command
            ? ["cancelled", "expired", "failed"].includes(command.status)
              ? command.status === "expired"
                ? "Expired"
                : "Cancelled"
              : command.status === "queued"
                ? "Ready"
                : command.status === "claimed"
                  ? "Risk Check Pending"
                  : "Submitted"
            : !trading.permissionActive
              ? "Waiting for Confirmation"
              : trading.blockers.length
                ? "Risk Check Pending"
                : "Ready";
          if (proposalStatus === "Ready") {
            try {
              const ctx = await tradeContext(tx, c.id, now());
              orderRisk(ctx, {
                kind: "OPEN",
                side: a.decision,
                symbol: a.symbol,
                stop: a.stopLoss,
                takeProfit: a.takeProfit,
                maxLots: Math.min(
                  a.proposedLots,
                  ctx.settings.sizingMode === "capped"
                    ? ctx.settings.lotSize
                    : ctx.execution.maxVolume,
                ),
                source: "ai",
                engineVersion: ENGINE_VERSION,
                signalExpiresAt: a.expiresAt,
                signalBarTime: a.profile.decisionBarTime,
                signalStrategy: a.strategy,
                signalConfidence: a.confidence,
              });
            } catch {
              proposalStatus = "Risk Check Pending";
            }
          }
          opportunities.push({
            id: analysis.id,
            symbol: a.symbol,
            decision: a.decision,
            status: proposalStatus,
            entryPrice: a.entryPrice,
            stopLoss: a.stopLoss,
            takeProfit: a.takeProfit,
            strategy: a.strategy,
            confidence: a.confidence,
            reasoning: a.reasoning,
            analyzedAt: a.analyzedAt,
            expiresAt: a.expiresAt,
          });
        }
      }
      const [health] = await tx.query(
        "SELECT state,checked_at,last_success_at,error FROM rocket_ai_health WHERE connection_id=?",
        [c.id],
      );
      return {
        serverTime: now(),
        connection: {
          id: c.id,
          status: fresh
            ? "Connected"
            : i?.last_error === "ACCOUNT_MISMATCH"
              ? "Account Mismatch"
              : i?.last_error === "AUTHENTICATION_FAILED"
                ? "Authentication Failed"
                : "Disconnected",
          fresh,
          lastHeartbeat: i?.last_heartbeat ? Number(i.last_heartbeat) : null,
        },
        account,
        accountKey: key,
        authorizedSymbols: registered
          ? [
              {
                symbol: registration.symbol,
                bid: symbolFresh ? market.bid : null,
                ask: symbolFresh ? market.ask : null,
                receivedAt: symbolFresh
                  ? Number(marketRow.received_at)
                  : Number(registration.received_at),
                fresh: symbolFresh,
                active: true,
              },
            ]
          : [],
        positions,
        opportunities,
        latestSignal,
        brokerPending,
        history,
        performance,
        ai: health
          ? {
              state: health.state,
              checkedAt: Number(health.checked_at),
              lastSuccessAt: health.last_success_at
                ? Number(health.last_success_at)
                : null,
              error: health.error,
            }
          : { state: "unavailable" },
        automation: trading.automation,
        risk: fresh ? trading.risk : null,
        blockers: trading.blockers,
        permissionActive: trading.permissionActive,
        liveConfirmed: trading.liveConfirmed,
      };
    });
  }
  return { status };
}
