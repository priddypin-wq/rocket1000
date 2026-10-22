import { randomUUID, randomBytes, createHash } from "node:crypto";
import { ApiError } from "./errors.mjs";
import {
  validateSnapshot,
  adaptiveProfile,
  decisionBar,
  requireMultiTimeframe,
  sanitizePositions,
} from "./market.mjs";
import { markManagedPositions } from "./position-ownership.mjs";
import { winningAdditionAllowed } from "./winning-additions.mjs";
import { selectedStrategyProfile } from "./strategy.mjs";
import { configuredModel, isConfiguredModel } from "./ai-provider.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { demoValidation, recordDemoValidation } from "./demo-validation.mjs";
import { validateRisk } from "../lib/risk.mjs";
import {
  accountKey,
  tradeSettings,
  validateTradeSettings,
  liveConsent,
  freezeCommandAccounts,
} from "./trade-settings.mjs";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const idPattern = /^[a-f0-9-]{36}$/;
const sessionPattern = /^[a-f0-9]{24,64}$/;
export const MAX_SPREAD_POINTS = 30,
  MAX_SLIPPAGE_POINTS = 10;

export function validateExecution(s) {
  const positive = [
    "tickSize",
    "tickValue",
    "point",
    "volumeStep",
    "minVolume",
    "maxVolume",
    "dayStartEquity",
    "peakEquity",
  ];
  const nonnegative = [
    "stopLevel",
    "dailyLoss",
    "existingRisk",
    "freeMargin",
    "pendingOrders",
  ];
  const flags = [
    "tradeAllowed",
    "stopsVerified",
    "newsVerified",
    "newsBlocked",
  ];
  if (
    !s ||
    positive.some((k) => !Number.isFinite(s[k]) || s[k] <= 0) ||
    nonnegative.some((k) => !Number.isFinite(s[k]) || s[k] < 0) ||
    flags.some((k) => typeof s[k] !== "boolean") ||
    s.maxVolume < s.minVolume ||
    s.volumeStep > s.maxVolume ||
    !Number.isInteger(s.pendingOrders)
  )
    throw new ApiError(422, "Broker execution data is incomplete.");
  const clean = Object.fromEntries(
    [...positive, ...nonnegative, ...flags].map((k) => [k, s[k]]),
  );
  for (const key of ["realizedToday", "freezeLevel"])
    if (s[key] !== undefined) {
      if (!Number.isFinite(s[key]) || (key === "freezeLevel" && s[key] < 0))
        throw new ApiError(422, "Invalid broker risk data.");
      clean[key] = s[key];
    }
  clean.protocol = s.protocol === 4 ? 4 : 3;
  clean.terminalId =
    typeof s.terminalId === "string" && /^[a-f0-9]{24,64}$/.test(s.terminalId)
      ? s.terminalId
      : "";
  clean.engineVersion =
    s.engineVersion === ENGINE_VERSION ? ENGINE_VERSION : "";
  if (s.accountMarginMode !== undefined) {
    if (![0, 1, 2].includes(s.accountMarginMode))
      throw new ApiError(422, "Invalid MT5 account margin mode.");
    clean.accountMarginMode = s.accountMarginMode;
  }
  for (const name of [
    "positionsAvailable",
    "brokerPendingAvailable",
    "sessionOpen",
  ])
    if (s[name] !== undefined) {
      if (typeof s[name] !== "boolean")
        throw new ApiError(422, "Invalid broker completeness checks.");
      clean[name] = s[name];
    }
  for (const name of [
    "symbolTradeMode",
    "tradeExecutionMode",
    "orderMode",
    "fillingMode",
  ])
    if (s[name] !== undefined) {
      if (!Number.isSafeInteger(s[name]) || s[name] < 0 || s[name] > 2147483647)
        throw new ApiError(422, "Invalid broker execution permissions.");
      clean[name] = s[name];
    }
  if (s.positions !== undefined)
    clean.positions = sanitizePositions(s.positions);
  if (s.account !== undefined) {
    const a = s.account;
    if (
      !a ||
      ![a.balance, a.equity].every(Number.isFinite) ||
      !(a.dailyProfitLoss === null || Number.isFinite(a.dailyProfitLoss)) ||
      typeof a.currency !== "string" ||
      !/^[A-Z]{3,8}$/.test(a.currency) ||
      typeof a.brokerName !== "string" ||
      !a.brokerName.trim() ||
      a.brokerName.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(a.brokerName)
    )
      throw new ApiError(422, "Invalid broker account financials.");
    clean.account = Object.fromEntries(
      ["balance", "equity", "currency", "brokerName", "dailyProfitLoss"].map(
        (k) => [k, a[k]],
      ),
    );
  }
  if (s.tradeHistory !== undefined) {
    const h = s.tradeHistory;
    if (
      !h ||
      typeof h.available !== "boolean" ||
      !Number.isSafeInteger(h.from) ||
      !Number.isSafeInteger(h.to) ||
      h.from <= 0 ||
      h.to < h.from ||
      h.to - h.from > 31 * 86400000 ||
      typeof h.currency !== "string" ||
      !/^[A-Z]{3,8}$/.test(h.currency) ||
      !Array.isArray(h.deals) ||
      h.deals.length > 100
    )
      throw new ApiError(422, "Invalid broker deal history.");
    clean.tradeHistory = {
      available: h.available,
      from: h.from,
      to: h.to,
      currency: h.currency,
      deals: h.deals.map((d) => {
        if (
          !d ||
          ["ticket", "order", "positionIdentifier"].some(
            (k) => typeof d[k] !== "string" || !/^\d{1,20}$/.test(d[k]),
          ) ||
          typeof d.symbol !== "string" ||
          !/^\S{1,40}$/.test(d.symbol) ||
          !["BUY", "SELL"].includes(d.side) ||
          !["IN", "OUT", "OUT_BY", "INOUT"].includes(d.entry) ||
          ![d.volume, d.price].every((v) => Number.isFinite(v) && v > 0) ||
          ![d.profit, d.commission, d.swap, d.fee].every(Number.isFinite) ||
          !Number.isSafeInteger(d.time) ||
          d.time < h.from ||
          d.time > h.to ||
          !Number.isSafeInteger(d.magic) ||
          d.magic < 0 ||
          typeof d.comment !== "string" ||
          d.comment.length > 64 ||
          typeof d.originComment !== "string" ||
          d.originComment.length > 64 ||
          !(
            (typeof d.reason === "string" && d.reason.length <= 40) ||
            Number.isSafeInteger(d.reason)
          )
        )
          throw new ApiError(422, "Invalid broker deal record.");
        return Object.fromEntries(
          [
            "ticket",
            "order",
            "positionIdentifier",
            "symbol",
            "side",
            "entry",
            "reason",
            "volume",
            "price",
            "profit",
            "commission",
            "swap",
            "fee",
            "time",
            "magic",
            "comment",
            "originComment",
          ]
            .map((k) => [k, d[k]])
            .concat([["ownedIntegrity", d.ownedIntegrity === true]]),
        );
      }),
    };
  }
  if (s.brokerPending !== undefined) {
    if (!Array.isArray(s.brokerPending) || s.brokerPending.length > 100)
      throw new ApiError(422, "Invalid broker pending orders.");
    clean.brokerPending = s.brokerPending.map((o) => {
      if (
        !o ||
        typeof o.ticket !== "string" ||
        !/^\d{1,20}$/.test(o.ticket) ||
        typeof o.symbol !== "string" ||
        !/^\S{1,40}$/.test(o.symbol) ||
        typeof o.side !== "string" ||
        !/^(BUY|SELL)(_(LIMIT|STOP|STOP_LIMIT))?$/.test(o.side) ||
        ![o.volume, o.price].every((v) => Number.isFinite(v) && v > 0) ||
        ![o.stop, o.takeProfit].every((v) => Number.isFinite(v) && v >= 0) ||
        !Number.isSafeInteger(o.createdAt) ||
        o.createdAt <= 0 ||
        !Number.isSafeInteger(o.magic) ||
        o.magic < 0 ||
        typeof o.originComment !== "string" ||
        o.originComment.length > 64
      )
        throw new ApiError(422, "Invalid broker pending order record.");
      return Object.fromEntries(
        [
          "ticket",
          "symbol",
          "side",
          "volume",
          "price",
          "stop",
          "takeProfit",
          "createdAt",
          "magic",
          "originComment",
        ]
          .map((k) => [k, o[k]])
          .concat([["ownedIntegrity", o.ownedIntegrity === true]]),
      );
    });
  }
  if (s.performance !== undefined) {
    const p = s.performance;
    if (
      !p ||
      typeof p.available !== "boolean" ||
      !Number.isSafeInteger(p.from) ||
      !Number.isSafeInteger(p.to) ||
      p.from <= 0 ||
      p.to < p.from ||
      p.to - p.from > 31 * 86400000 ||
      typeof p.currency !== "string" ||
      !/^[A-Z]{3,8}$/.test(p.currency)
    )
      throw new ApiError(422, "Invalid broker performance history.");
    clean.performance = {
      available: p.available,
      from: p.from,
      to: p.to,
      currency: p.currency,
    };
    if (p.available) {
      if (
        ["closedDeals", "wins", "losses"].some(
          (k) => !Number.isInteger(p[k]) || p[k] < 0 || p[k] > 10000,
        ) ||
        p.wins + p.losses > p.closedDeals ||
        ["grossProfit", "grossLoss", "netProfit"].some(
          (k) => !Number.isFinite(p[k]),
        ) ||
        p.grossProfit < 0 ||
        p.grossLoss < 0
      )
        throw new ApiError(422, "Invalid broker performance totals.");
      for (const k of [
        "closedDeals",
        "wins",
        "losses",
        "grossProfit",
        "grossLoss",
        "netProfit",
      ])
        clean.performance[k] = p[k];
    }
  }
  return clean;
}
export async function disableTrading(tx, cid, now = Date.now()) {
  await tx.query("DELETE FROM rocket_trade_policy WHERE connection_id=?", [
    cid,
  ]);
  await tx.query(
    "UPDATE rocket_trade_commands SET status=? WHERE connection_id=? AND status=?",
    ["cancelled", cid, "queued"],
  );
  await tx.query(
    "UPDATE rocket_automation SET state='stopped',run_id=?,lease_until=0 WHERE connection_id=?",
    [randomUUID(), cid],
  );
  // A submitted/claimed command is never silently retried. The broker outcome may be unknown.
  await expireCommands(tx, cid, now);
}
// Emergency Stop revokes activation. Pausing automation and routine disconnects
// preserve the account's approval for a separately reviewed restart.
export async function revokeLiveActivation(tx, uid, now, { key } = {}) {
  const scope = key ? " AND account_key=?" : "";
  await tx.query(
    `DELETE FROM rocket_live_consents WHERE user_id=?${scope}`,
    key ? [uid, key] : [uid],
  );
  await tx.query(
    `UPDATE rocket_live_approvals SET expires_at=? WHERE user_id=? AND used_at IS NULL${scope}`,
    key ? [now, uid, key] : [now, uid],
  );
}
async function expireCommands(tx, cid, now) {
  await tx.query(
    "UPDATE rocket_trade_commands SET status=? WHERE connection_id=? AND status=? AND expires_at<=?",
    ["expired", cid, "queued", now],
  );
  await tx.query(
    "UPDATE rocket_trade_commands SET status=? WHERE connection_id=? AND status IN ('claimed','sending') AND expires_at<=?",
    ["uncertain", cid, now],
  );
}
export async function tradeContext(tx, cid, now) {
  const [c] = await tx.query(
    `SELECT * FROM rocket_direct_connections WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
    [cid],
  );
  const [i] = await tx.query(
    "SELECT * FROM rocket_direct_installations WHERE connection_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [cid],
  );
  const [x] = await tx.query(
    "SELECT * FROM rocket_execution WHERE connection_id=?",
    [cid],
  );
  const [m] = await tx.query(
    "SELECT * FROM rocket_market_snapshots WHERE connection_id=?",
    [cid],
  );
  const [symbolRegistration] = await tx.query(
    "SELECT * FROM rocket_ea_symbols WHERE connection_id=?",
    [cid],
  );
  const [p] = await tx.query(
    "SELECT * FROM rocket_trade_policy WHERE connection_id=?",
    [cid],
  );
  const { settings, revision } = await tradeSettings(tx, cid);
  const consent = await liveConsent(tx, c);
  const [analysisEngine] = await tx.query(
    "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
    [cid],
  );
  const [scheduler] = await tx.query(
    "SELECT last_seen FROM rocket_engine_scheduler ORDER BY last_seen DESC LIMIT 1",
  );
  const [credential] = await tx.query(
    "SELECT model FROM rocket_openai_credentials WHERE user_id=?",
    [c.user_id],
  );
  const analysisEngineActive = !!(
    analysisEngine &&
    ["scheduled", "running"].includes(analysisEngine.state) &&
    analysisEngine.installation_id === i?.id &&
    analysisEngine.session_id === x?.session_id &&
    analysisEngine.account_key === consent.key &&
    scheduler &&
    now - Number(scheduler.last_seen) < 150000
  );
  const validation = await demoValidation(tx, c.user_id);
  await freezeCommandAccounts(tx, cid);
  const [automation] = await tx.query(
    "SELECT * FROM rocket_automation WHERE connection_id=?",
    [cid],
  );
  await expireCommands(tx, cid, now);
  const [unresolved] = await tx.query(
    "SELECT t.id FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.connection_id=? AND a.account_key=? AND t.status IN ('claimed','sending','uncertain') LIMIT 1",
    [cid, consent.key],
  );
  const blockers = [];
  if (
    !i ||
    i.revoked_at ||
    Number(i.expires_at) <= now ||
    i.last_error ||
    !i.registered_at ||
    now - Number(i.last_heartbeat) > 30000
  )
    blockers.push("A fresh authenticated MT5 heartbeat is required.");
  if (!x || x.installation_id !== i?.id || now - Number(x.received_at) > 30000)
    blockers.push("Install EA 5.00 and wait for fresh execution checks.");
  let market = null,
    execution = null;
  try {
    if (
      !m ||
      m.installation_id !== i?.id ||
      now - Number(m.received_at) > 30000
    )
      throw Error();
    market = validateSnapshot(JSON.parse(m.payload), now);
  } catch {
    blockers.push("Fresh broker prices and account values are required.");
  }
  try {
    if (x) execution = validateExecution(JSON.parse(x.payload));
  } catch {
    blockers.push("Broker execution checks are invalid.");
  }
  if (
    symbolRegistration &&
    (symbolRegistration.installation_id !== i?.id ||
      symbolRegistration.session_id !== x?.session_id ||
      symbolRegistration.account_key !== consent.key ||
      (market && symbolRegistration.symbol !== market.symbol))
  )
    blockers.push(
      "The exact EA chart symbol and account must be registered before trading.",
    );
  if (execution?.positions !== undefined) {
    if (!execution.positionsAvailable)
      blockers.push("A complete broker position reconciliation is required.");
    if (market) market.positions = execution.positions;
  }
  if (execution && !execution.tradeAllowed)
    blockers.push(
      "Enable this EA's Algo Trading permission in MT5 before enabling orders here.",
    );
  const connectionBlockers = [...blockers];
  if (execution && market) {
    if (execution.sessionOpen === false)
      blockers.push(
        "The connected broker symbol is outside its trading session.",
      );
    if (
      execution.symbolTradeMode === 0 ||
      execution.symbolTradeMode === 3 ||
      (execution.orderMode !== undefined && !(execution.orderMode & 1))
    )
      blockers.push(
        "The broker symbol does not currently permit new market orders.",
      );
    if (!execution.stopsVerified || market.positions.some((v) => v.stop <= 0))
      blockers.push("Every existing position needs a protective stop-loss.");
    if (!execution.newsVerified)
      blockers.push("MT5 economic calendar verification is unavailable.");
    if (execution.newsBlocked)
      blockers.push("High-impact news blocks new orders.");
    if (market.positions.length >= settings.maxPositions)
      blockers.push(
        `Maximum ${settings.maxPositions} open positions; your account already meets or exceeds this limit.`,
      );
    if (
      execution.dailyLoss >=
      (execution.dayStartEquity * settings.maxDailyLossPct) / 100
    )
      blockers.push("Daily loss limit reached.");
    if (
      (execution.peakEquity - market.equity) / execution.peakEquity >=
      settings.maxDrawdownPct / 100
    )
      blockers.push(`${settings.maxDrawdownPct}% drawdown limit reached.`);
    if (
      execution.existingRisk >=
      Math.min(market.balance, market.equity) * 0.03
    )
      blockers.push("3% aggregate risk limit reached.");
    const spreadCap =
      execution.protocol === 4 ? settings.maxSpreadPoints : MAX_SPREAD_POINTS;
    if ((market.ask - market.bid) / execution.point > spreadCap + 1e-6)
      blockers.push(`Spread exceeds ${spreadCap} points.`);
    if (execution.freeMargin <= 0) blockers.push("No free margin available.");
    if (execution.pendingOrders > 0)
      blockers.push(
        "Existing pending broker orders must be resolved before new orders.",
      );
  }
  if (unresolved)
    blockers.push(
      "A previous order needs broker reconciliation; new orders are blocked.",
    );
  const profile = market ? adaptiveProfile(market, settings) : null;
  if (profile?.ready && profile.effectiveRiskPct <= 0)
    blockers.push(
      profile.reason || "Current market conditions block new entries.",
    );
  if (i?.account_type === "live" && !validation.passed)
    blockers.push(
      "Complete the current engine's Demo execution validation before real-money trading.",
    );
  const permissionActive = !!(
    p &&
    !c.stopped &&
    p.installation_id === i?.id &&
    p.session_id === x?.session_id &&
    Number(p.expires_at) > now &&
    connectionBlockers.length === 0 &&
    (i.account_type !== "live" ||
      (consent.confirmed &&
        validation.passed &&
        execution?.protocol === 4 &&
        !!execution.terminalId &&
        execution.engineVersion === ENGINE_VERSION)) &&
    !(
      i.account_type === "live" &&
      process.env.ROCKET_DISABLE_LIVE_ORDERS === "1"
    )
  );
  if (market)
    await markManagedPositions(tx, cid, consent.key, market.positions);
  return {
    c,
    i,
    x,
    market,
    execution,
    policy: p,
    blockers,
    connectionBlockers,
    unresolved,
    permissionActive,
    enabled: permissionActive && blockers.length === 0,
    settings,
    revision,
    consent,
    automation,
    analysisEngine,
    analysisEngineActive,
    aiModel: credential?.model || configuredModel(),
    demoValidation: validation,
    profile,
    now,
  };
}
const context = tradeContext;
export function orderRisk(ctx, order) {
  const { market: m, execution: e } = ctx;
  const spreadCap =
      e?.protocol === 4 ? ctx.settings.maxSpreadPoints : MAX_SPREAD_POINTS,
    slippageCap =
      e?.protocol === 4 ? ctx.settings.maxSlippagePoints : MAX_SLIPPAGE_POINTS;
  const kind = order?.kind || "OPEN";
  const strategyProfile =
    ctx.profile && m
      ? selectedStrategyProfile(m, ctx.settings, ctx.profile, e)
      : null;
  if (!["OPEN", "MODIFY", "CLOSE"].includes(kind))
    throw new ApiError(400, "Unsupported broker operation.");
  if (
    (order?.source === "ai" || (kind === "CLOSE" && order?.analysisId)) &&
    (order.engineVersion !== ENGINE_VERSION ||
      order.signalExpiresAt <= ctx.now ||
      order.signalBarTime !== decisionBar(m) ||
      (kind === "OPEN" &&
        (!ctx.profile?.ready ||
          !strategyProfile?.allowedStrategies.includes(order.signalStrategy))))
  )
    throw new ApiError(
      409,
      "AI signal expired or market conditions no longer permit this strategy.",
    );
  if (kind !== "OPEN") {
    if (
      !ctx.permissionActive ||
      ctx.connectionBlockers.length ||
      ctx.unresolved
    )
      throw new ApiError(
        409,
        "Verified trading permission and an unambiguous broker state are required.",
      );
    if (e.protocol !== 4)
      throw new ApiError(409, "Upgrade to EA 5.00 for position management.");
    const p = m?.positions.find(
      (p) => p.ticket === order.position && p.managed,
    );
    if (!p)
      throw new ApiError(
        403,
        "Only positions with verified ownership opened by this connection can be managed.",
      );
    let quote = m;
    if (p.symbol !== m.symbol) {
      const q = p.execution;
      if (
        kind !== "CLOSE" ||
        !q ||
        !q.tradeAllowed ||
        Math.abs(ctx.now - q.timestamp) > 30000 ||
        Math.abs(q.brokerTimestamp - q.timestamp) > 86400000 ||
        q.brokerTimestamp - q.quoteTimestamp > 15000 ||
        q.quoteTimestamp - q.brokerTimestamp > 2000
      )
        throw new ApiError(
          409,
          "Fresh broker execution checks for this position's exact symbol are required before closing it.",
        );
      quote = q;
    }
    const entry = p.side === "BUY" ? quote.bid : quote.ask;
    let volume = p.volume;
    if (kind === "CLOSE" && order.partialClose === true) {
      const specs = p.symbol === m.symbol ? e : quote;
      volume = order.volume;
      if (
        !Number.isFinite(volume) ||
        volume <= 0 ||
        volume >= p.volume ||
        volume < specs.minVolume ||
        volume > specs.maxVolume ||
        Math.abs(
          volume / specs.volumeStep - Math.round(volume / specs.volumeStep),
        ) > 1e-5 ||
        p.volume - volume + 1e-8 < specs.minVolume ||
        Math.abs(
          (p.volume - volume) / specs.volumeStep -
            Math.round((p.volume - volume) / specs.volumeStep),
        ) > 1e-5
      )
        throw new ApiError(
          422,
          "Partial close must respect broker volume steps and leave a valid remaining position.",
        );
    }
    if (
      order.positionVolume !== undefined &&
      Math.abs(order.positionVolume - p.volume) > 1e-8
    )
      throw new ApiError(
        409,
        "Position volume changed. Wait for reconciliation and a fresh decision.",
      );
    const symbolExecution = p.symbol === m.symbol ? e : quote;
    if (
      symbolExecution.sessionOpen === false ||
      symbolExecution.symbolTradeMode === 0 ||
      (kind === "CLOSE" &&
        symbolExecution.orderMode !== undefined &&
        !(symbolExecution.orderMode & 1))
    )
      throw new ApiError(
        409,
        "This position's broker symbol is not currently available for the requested operation.",
      );
    if (kind === "MODIFY") {
      const distance = Math.max(e.stopLevel, e.freezeLevel || 0) * e.point;
      if (
        ![order.stop, order.takeProfit].every(
          (n) => Number.isFinite(n) && n > 0,
        ) ||
        (p.side === "BUY"
          ? (p.stop > 0 && order.stop < p.stop) ||
            order.stop >= m.bid - distance ||
            order.takeProfit <= m.ask + distance
          : (p.stop > 0 && order.stop > p.stop) ||
            order.stop <= m.ask + distance ||
            order.takeProfit >= m.bid - distance) ||
        Math.abs(
          order.stop / e.tickSize - Math.round(order.stop / e.tickSize),
        ) > 1e-5 ||
        Math.abs(
          order.takeProfit / e.tickSize -
            Math.round(order.takeProfit / e.tickSize),
        ) > 1e-5
      )
        throw new ApiError(
          422,
          "A modification must tighten the stop and keep valid broker price distances.",
        );
      if (
        Math.abs(order.stop - p.stop) < e.tickSize / 2 &&
        Math.abs(order.takeProfit - p.takeProfit) < e.tickSize / 2
      )
        throw new ApiError(
          422,
          "The protective stop and target are unchanged.",
        );
    }
    return {
      kind,
      symbol: p.symbol,
      side: p.side,
      position: p.ticket,
      positionIdentifier: p.identifier,
      positionComment: p.comment,
      volume,
      positionVolume: p.volume,
      ...(kind === "CLOSE" && order.partialClose === true
        ? { partialClose: true }
        : {}),
      entry,
      stop: kind === "MODIFY" ? order.stop : p.stop,
      takeProfit: kind === "MODIFY" ? order.takeProfit : p.takeProfit,
      maxLots: p.volume,
      maxSpread: spreadCap,
      maxSlippage: slippageCap,
      riskAmount: 0,
      pricePoint: p.symbol === m.symbol ? e.point : quote.point,
      revision: ctx.revision,
    };
  }
  if (!m || !e || ctx.blockers.length)
    throw new ApiError(
      409,
      ctx.blockers.join(" ") || "Broker checks unavailable.",
    );
  if (!ctx.enabled)
    throw new ApiError(
      409,
      "Explicitly enable orders for this MT5 session first.",
    );
  if (
    !order ||
    !["BUY", "SELL"].includes(order.side) ||
    ![order.stop, order.takeProfit, order.maxLots].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    order.symbol !== m.symbol
  )
    throw new ApiError(
      400,
      "Specify the chart symbol, side, stop-loss, take-profit and maximum lots.",
    );
  if (!winningAdditionAllowed(ctx, order.side))
    throw new ApiError(
      409,
      "A position already exists on this symbol. Additions require a hedging account and verified winning positions protected at break-even. Adding to losses, averaging or offsetting positions is disabled.",
    );
  const entry = order.side === "BUY" ? m.ask : m.bid;
  if (
    (e.symbolTradeMode === 1 && order.side !== "BUY") ||
    (e.symbolTradeMode === 2 && order.side !== "SELL")
  )
    throw new ApiError(
      409,
      "The broker currently restricts this symbol's trade direction.",
    );
  if (order.source === "ai") {
    if (
      order.signalStrategy === "scalping" &&
      (!ctx.profile.scalpingEligible || ctx.profile.scalpingSide !== order.side)
    )
      throw new ApiError(
        409,
        "Current M1 and M5 trend direction no longer permits this scalp.",
      );
    const minimumStop =
      Math.max(ctx.settings.stopLossPoints, e.stopLevel + 2) * e.point;
    const minimumTarget =
      Math.max(ctx.settings.takeProfitPoints, e.stopLevel + 2) * e.point;
    if (
      !Number.isFinite(order.signalConfidence) ||
      order.signalConfidence < ctx.profile.minConfidence ||
      Math.abs(entry - order.stop) + 1e-8 < minimumStop ||
      Math.abs(entry - order.takeProfit) + 1e-8 < minimumTarget ||
      Math.abs(entry - order.takeProfit) / Math.abs(entry - order.stop) + 1e-8 <
        ctx.profile.minRewardRisk
    )
      throw new ApiError(
        409,
        "Current price, confidence or protective distances no longer meet the selected AI mode.",
      );
  }
  const distance = e.stopLevel * e.point;
  const reference = order.side === "BUY" ? m.bid : m.ask;
  if (
    order.side === "BUY"
      ? order.stop >= reference - distance ||
        order.takeProfit <= entry + distance
      : order.stop <= reference + distance ||
        order.takeProfit >= entry - distance
  )
    throw new ApiError(
      422,
      "Protective stop and take-profit must be on the correct side and outside the broker's minimum distance.",
    );
  for (const price of [order.stop, order.takeProfit])
    if (Math.abs(price / e.tickSize - Math.round(price / e.tickSize)) > 1e-5)
      throw new ApiError(422, "Prices must follow the broker's tick size.");
  const risk = validateRisk({
    ...e,
    balance: m.balance,
    equity: m.equity,
    openPositions: m.positions.length,
    entry:
      entry + (order.side === "BUY" ? slippageCap : -slippageCap) * e.point,
    stop: order.stop,
    side: order.side,
    maxVolume: Math.min(
      e.maxVolume,
      ctx.settings.sizingMode === "capped" ? ctx.settings.lotSize : e.maxVolume,
      order.maxLots,
    ),
    spread: (m.ask - m.bid) / e.point,
    maxSpread: spreadCap,
    slippage: slippageCap,
    maxSlippage: slippageCap,
    maxDrawdown: ctx.settings.maxDrawdownPct / 100,
    riskPerTrade:
      (ctx.profile?.ready
        ? ctx.profile.effectiveRiskPct
        : Math.min(ctx.settings.riskPerTradePct, 0.5)) / 100,
    dailyLossLimit: ctx.settings.maxDailyLossPct / 100,
    positionLimit: ctx.settings.maxPositions,
    connected: true,
    mode: ctx.i.account_type,
    liveAuthorized: ctx.i.account_type === "live",
    demoAuthorized: ctx.i.account_type === "demo",
    safetyVerified: e.stopsVerified,
  });
  if (!risk.approved) throw new ApiError(422, risk.reasons.join(" "));
  return {
    side: order.side,
    symbol: order.symbol,
    stop: order.stop,
    takeProfit: order.takeProfit,
    maxLots: order.maxLots,
    kind,
    revision: ctx.revision,
    entry,
    volume: risk.volume,
    maxSpread: spreadCap,
    maxSlippage: slippageCap,
    riskAmount:
      (Math.abs(
        entry +
          (order.side === "BUY" ? slippageCap : -slippageCap) * e.point -
          order.stop,
      ) /
        e.tickSize) *
      e.tickValue *
      risk.volume,
    riskPercent: ctx.profile?.ready
      ? ctx.profile.effectiveRiskPct
      : Math.min(ctx.settings.riskPerTradePct, 0.5),
  };
}
export function tradingService(db, { now = Date.now } = {}) {
  async function owned(tx, uid) {
    const [c] = await tx.query(
      `SELECT id FROM rocket_direct_connections WHERE user_id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
      [uid],
    );
    if (!c) throw new ApiError(409, "Connect MT5 first.");
    return c.id;
  }
  async function status(uid) {
    return db.transaction(async (tx) => {
      const cid = await owned(tx, uid);
      const ctx = await context(tx, cid, now());
      const orders = await tx.query(
        "SELECT t.id,t.status,t.payload,t.result,t.created_at FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.connection_id=? AND a.account_key=? ORDER BY t.created_at DESC LIMIT 10",
        [cid, ctx.consent.key],
      );
      const activationEvents = await tx.query(
        "SELECT event,created_at FROM rocket_direct_audit WHERE user_id=? AND connection_id=? AND event IN ('live_activation_review_prepared','live_account_explicitly_confirmed','live_account_confirmation_revoked','emergency_stop_all_live_permissions_revoked','reviewed_orders_disabled','risk_settings_changed_automation_stopped','automatic_trading_paused','automatic_live_trading_started','automatic_demo_trading_started','reviewed_live_orders_enabled_15_minutes','reviewed_demo_orders_enabled_15_minutes') ORDER BY created_at DESC LIMIT 10",
        [uid, cid],
      );
      return {
        enabled: ctx.enabled,
        permissionActive: ctx.permissionActive,
        brokerOutcomePending: !!ctx.unresolved,
        connectionBlockers: ctx.connectionBlockers,
        accountKey: ctx.consent.key,
        liveConfirmed: ctx.consent.confirmed,
        liveConfirmedAt: ctx.consent.confirmedAt,
        settingsRevision: ctx.revision,
        sessionId: ctx.x?.session_id || null,
        installationId: ctx.i?.id || null,
        activationEvents: activationEvents.map((event) => ({
          event: event.event,
          createdAt: Number(event.created_at),
        })),
        settings: ctx.settings,
        demoValidation: ctx.demoValidation,
        profile: ctx.profile,
        sizing:
          ctx.market && ctx.execution && ctx.profile?.ready
            ? {
                mode: ctx.settings.sizingMode,
                basisBalance: Math.min(ctx.market.balance, ctx.market.equity),
                riskBudget:
                  (Math.min(ctx.market.balance, ctx.market.equity) *
                    ctx.profile.effectiveRiskPct) /
                  100,
                currency: ctx.market.currency,
                lotCap:
                  ctx.settings.sizingMode === "capped"
                    ? Math.min(ctx.settings.lotSize, ctx.execution.maxVolume)
                    : ctx.execution.maxVolume,
              }
            : null,
        performance: ctx.execution?.performance || { available: false },
        automation: ctx.automation
          ? {
              state: ctx.automation.state,
              waiting: ctx.automation.state === "running" && !ctx.enabled,
              lastCycle: Number(ctx.automation.last_cycle),
              lastError: ctx.automation.last_error,
            }
          : null,
        risk: ctx.execution
          ? {
              dailyLoss: ctx.execution.dailyLoss,
              realizedToday: ctx.execution.realizedToday ?? null,
              drawdownPct: ctx.market
                ? Math.max(
                    0,
                    ((ctx.execution.peakEquity - ctx.market.equity) /
                      ctx.execution.peakEquity) *
                      100,
                  )
                : null,
            }
          : null,
        positions: ctx.market?.positions || [],
        expiresAt: ctx.enabled ? Number(ctx.policy.expires_at) : null,
        blockers: ctx.blockers,
        account: ctx.i?.registered_at
          ? {
              login: ctx.i.account_login,
              server: ctx.i.broker_server,
              type: ctx.i.account_type,
            }
          : null,
        market: ctx.market
          ? {
              symbol: ctx.market.symbol,
              balance: ctx.market.balance,
              equity: ctx.market.equity,
              currency: ctx.market.currency,
              bid: ctx.market.bid,
              ask: ctx.market.ask,
              positions: ctx.market.positions.length,
            }
          : null,
        orders: orders.map((o) => ({
          id: o.id,
          status: o.status,
          order: JSON.parse(o.payload),
          result: o.result ? JSON.parse(o.result) : null,
          createdAt: Number(o.created_at),
        })),
      };
    });
  }
  async function act(uid, input) {
    return db.transaction(async (tx) => {
      const cid = await owned(tx, uid);
      const audit = (event) =>
        tx.query(
          "INSERT INTO rocket_direct_audit(id,user_id,connection_id,event,created_at) VALUES(?,?,?,?,?)",
          [randomUUID(), uid, cid, event, now()],
        );
      if (input?.action === "pause-auto") {
        await disableTrading(tx, cid, now());
        await tx.query(
          "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
          [cid],
        );
        await audit("automatic_trading_paused");
        return { ok: true };
      }
      if (input?.action === "disable") {
        await disableTrading(tx, cid, now());
        await revokeLiveActivation(tx, uid, now());
        await tx.query(
          "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
          [cid],
        );
        await audit("emergency_stop_all_live_permissions_revoked");
        return { ok: true };
      }
      const ctx = await context(tx, cid, now());
      if (input?.action === "settings") {
        const value = validateTradeSettings(input.settings);
        await disableTrading(tx, cid, now());
        await tx.query(
          "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
          [cid],
        );
        await tx.query(
          "UPDATE rocket_trade_preferences SET revision=?,payload=? WHERE connection_id=?",
          [randomUUID(), JSON.stringify(value), cid],
        );
        await tx.query(
          "DELETE FROM rocket_order_previews WHERE connection_id=?",
          [cid],
        );
        await audit("risk_settings_changed_automation_stopped");
        return { ok: true };
      }
      if (["prepare-live", "confirm-live"].includes(input?.action)) {
        if (
          ctx.i?.account_type !== "live" ||
          ctx.c.expected_type !== "live" ||
          ctx.c.expected_login !== ctx.i.account_login ||
          ctx.c.expected_server !== ctx.i.broker_server
        )
          throw new ApiError(
            409,
            "Connect and verify the specific Live MT5 account before activating it.",
            "LIVE_ACCOUNT_REQUIRED",
          );
        if (!ctx.demoValidation.passed)
          throw new ApiError(
            403,
            "Complete a successful Demo AI OPEN, stop modification and CLOSE cycle before enabling Live trading.",
            "DEMO_VALIDATION_REQUIRED",
          );
        if (process.env.ROCKET_DISABLE_LIVE_ORDERS === "1")
          throw new ApiError(
            403,
            "Live execution is disabled by the server operator.",
            "LIVE_OPERATOR_DISABLED",
          );
        if (input.accountKey !== ctx.consent.key)
          throw new ApiError(
            409,
            "The connected account changed. Review the Live account again.",
            "LIVE_ACCOUNT_CHANGED",
          );
        if (ctx.connectionBlockers.length || ctx.unresolved)
          throw new ApiError(
            409,
            ctx.connectionBlockers.join(" ") ||
              "Reconcile the previous broker request before activating Live trading.",
            "LIVE_VERIFICATION_REQUIRED",
          );
        if (
          ctx.execution?.protocol !== 4 ||
          ctx.execution.engineVersion !== ENGINE_VERSION ||
          !ctx.execution.terminalId
        )
          throw new ApiError(
            409,
            "Install EA 5.00 and wait for current execution checks before activating Live trading.",
            "LIVE_VERIFICATION_REQUIRED",
          );
        const serverTime = now();
        if (input.action === "prepare-live") {
          const review = {
            accountKey: ctx.consent.key,
            account: {
              login: ctx.i.account_login,
              server: ctx.i.broker_server,
              type: ctx.i.account_type,
            },
            settings: ctx.settings,
            currentRiskPct: ctx.profile?.ready
              ? ctx.profile.effectiveRiskPct
              : Math.min(ctx.settings.riskPerTradePct, 0.5),
          };
          const approvalId = randomUUID(),
            expiresAt = serverTime + 60000;
          // Only the most recently displayed review can activate this connection.
          await tx.query(
            "UPDATE rocket_live_approvals SET expires_at=? WHERE user_id=? AND connection_id=? AND used_at IS NULL",
            [serverTime, uid, cid],
          );
          await tx.query(
            "INSERT INTO rocket_live_approvals(id,user_id,connection_id,installation_id,session_id,account_key,settings_revision,engine_version,created_at,expires_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            [
              approvalId,
              uid,
              cid,
              ctx.i.id,
              ctx.x.session_id,
              ctx.consent.key,
              ctx.revision,
              ENGINE_VERSION,
              serverTime,
              expiresAt,
              JSON.stringify(review),
            ],
          );
          await audit("live_activation_review_prepared");
          return { approvalId, expiresAt, serverTime, ...review };
        }
        if (
          typeof input.approvalId !== "string" ||
          !idPattern.test(input.approvalId) ||
          input.acknowledgedRisk !== true ||
          input.confirmation !== `ENABLE LIVE ${ctx.i.account_login}`
        )
          throw new ApiError(
            400,
            "Review the Live account, acknowledge the risk and type its confirmation exactly.",
            "LIVE_APPROVAL_REQUIRED",
          );
        const [approval] = await tx.query(
          `SELECT * FROM rocket_live_approvals WHERE id=? AND user_id=? AND connection_id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [input.approvalId, uid, cid],
        );
        if (
          !approval ||
          approval.used_at !== null ||
          Number(approval.expires_at) <= serverTime ||
          approval.installation_id !== ctx.i.id ||
          approval.session_id !== ctx.x.session_id ||
          approval.account_key !== ctx.consent.key ||
          approval.settings_revision !== ctx.revision ||
          approval.engine_version !== ENGINE_VERSION
        )
          throw new ApiError(
            409,
            "Live activation review expired, was used or the MT5 account, session or risk settings changed. Review again.",
            "LIVE_APPROVAL_EXPIRED",
          );
        const consumed = await tx.query(
          "UPDATE rocket_live_approvals SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>? RETURNING id",
          [serverTime, approval.id, serverTime],
        );
        if (consumed.length !== 1)
          throw new ApiError(
            409,
            "Live activation review is no longer valid. Review again.",
            "LIVE_APPROVAL_EXPIRED",
          );
        // Activation grants permission for this account; a separate Start action
        // must establish a fresh execution policy, including after an upgrade.
        await disableTrading(tx, cid, serverTime);
        await tx.query(
          "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
          [cid],
        );
        await tx.query(
          "INSERT INTO rocket_live_consents(user_id,account_key,account_login,broker_server,confirmed_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,account_key) DO UPDATE SET account_login=excluded.account_login,broker_server=excluded.broker_server,confirmed_at=excluded.confirmed_at",
          [
            uid,
            ctx.consent.key,
            ctx.i.account_login,
            ctx.i.broker_server,
            serverTime,
          ],
        );
        await audit("live_account_explicitly_confirmed");
        return { ok: true, liveConfirmedAt: serverTime };
      }
      if (input?.action === "revoke-live") {
        await disableTrading(tx, cid, now());
        await tx.query(
          "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
          [cid],
        );
        await revokeLiveActivation(tx, uid, now(), { key: ctx.consent.key });
        await audit("live_account_confirmation_revoked");
        return { ok: true };
      }
      if (input?.action === "start-auto") {
        requireMultiTimeframe(ctx.market);
        if (
          ctx.execution?.protocol !== 4 ||
          !ctx.execution.terminalId ||
          ctx.execution.engineVersion !== ENGINE_VERSION
        )
          throw new ApiError(
            409,
            "Install EA 5.00 for multi-timeframe automatic trading.",
          );
        if (ctx.i?.account_type === "live" && !ctx.demoValidation.passed)
          throw new ApiError(
            403,
            "Complete a successful Demo AI OPEN, stop modification and CLOSE cycle before enabling Live trading.",
            "DEMO_VALIDATION_REQUIRED",
          );
        if (input.accountKey !== ctx.consent.key)
          throw new ApiError(
            409,
            "The connected account changed. Review it before starting.",
          );
        if (
          ctx.i?.account_type === "demo" &&
          input.confirmation !== `ENABLE DEMO ${ctx.i.account_login}`
        )
          throw new ApiError(
            400,
            "Explicitly confirm this Demo account before enabling automatic execution.",
            "DEMO_AUTHORIZATION_REQUIRED",
          );
        if (ctx.connectionBlockers.length || ctx.unresolved)
          throw new ApiError(
            409,
            ctx.connectionBlockers.join(" ") ||
              "Reconcile the previous broker request first.",
          );
        if (
          ctx.i.account_type === "live" &&
          (!ctx.consent.confirmed ||
            process.env.ROCKET_DISABLE_LIVE_ORDERS === "1")
        )
          throw new ApiError(
            403,
            "This live account requires your explicit confirmation before real-money orders.",
          );
        const runId = randomUUID();
        await tx.query(
          "INSERT INTO rocket_trade_policy(connection_id,installation_id,session_id,expires_at) VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET installation_id=excluded.installation_id,session_id=excluded.session_id,expires_at=excluded.expires_at",
          [cid, ctx.i.id, ctx.x.session_id, now() + 86400000],
        );
        await tx.query(
          "UPDATE rocket_direct_connections SET stopped=0 WHERE id=?",
          [cid],
        );
        await tx.query(
          "INSERT INTO rocket_automation(connection_id,run_id,installation_id,session_id,state) VALUES(?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET run_id=excluded.run_id,installation_id=excluded.installation_id,session_id=excluded.session_id,state=excluded.state,last_cycle=0,last_bar=0,last_action_bar=0,lease_until=0,last_error=NULL",
          [cid, runId, ctx.i.id, ctx.x.session_id, "running"],
        );
        await audit(`automatic_${ctx.i.account_type}_trading_started`);
        return { ok: true, executionMode: "broker", runId };
      }
      if (input?.action === "enable") {
        if (ctx.i?.account_type === "live" && !ctx.demoValidation.passed)
          throw new ApiError(
            403,
            "Complete Demo validation before enabling real-money orders.",
            "DEMO_VALIDATION_REQUIRED",
          );
        if (
          ctx.execution?.protocol === 4 &&
          input.accountKey !== ctx.consent.key
        )
          throw new ApiError(
            409,
            "The connected account changed. Review it before enabling orders.",
          );
        if (ctx.blockers.length)
          throw new ApiError(409, ctx.blockers.join(" "));
        if (
          input.confirmation !==
          `ENABLE ${ctx.i.account_type.toUpperCase()} ${ctx.i.account_login}`
        )
          throw new ApiError(
            400,
            "Type the displayed account confirmation exactly.",
          );
        if (ctx.i.account_type === "live") {
          if (process.env.ROCKET_DISABLE_LIVE_ORDERS === "1")
            throw new ApiError(
              403,
              "Live execution is disabled by the server operator.",
            );
          if (
            ctx.execution.protocol !== 4 ||
            ctx.execution.engineVersion !== ENGINE_VERSION ||
            !ctx.execution.terminalId
          )
            throw new ApiError(
              409,
              "Install EA 5.00 and wait for current execution checks before enabling Live orders.",
              "LIVE_VERIFICATION_REQUIRED",
            );
          if (!ctx.consent.confirmed)
            throw new ApiError(
              403,
              "Activate this specific Live account in Settings before enabling real-money orders.",
              "LIVE_APPROVAL_REQUIRED",
            );
        }
        await tx.query(
          "INSERT INTO rocket_trade_policy(connection_id,installation_id,session_id,expires_at) VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET installation_id=excluded.installation_id,session_id=excluded.session_id,expires_at=excluded.expires_at",
          [cid, ctx.i.id, ctx.x.session_id, now() + 900000],
        );
        await tx.query(
          "UPDATE rocket_direct_connections SET stopped=0 WHERE id=?",
          [cid],
        );
        await audit(`reviewed_${ctx.i.account_type}_orders_enabled_15_minutes`);
        return { ok: true };
      }
      if (input?.action === "preview") {
        const kind = input.order?.kind || "OPEN";
        let intent = input.order,
          provenance = { source: "user", manualReview: true };
        if (kind !== "CLOSE" || input.order?.partialClose === true) {
          // Browser fields cannot create an independent strategy decision.
          // Check supplied fields first for backwards-compatible safety errors.
          if (input.order?.side || kind !== "OPEN" || !ctx.enabled)
            orderRisk(ctx, input.order);
          const [latest] = await tx.query(
            "SELECT id,result FROM rocket_analyses WHERE connection_id=? AND installation_id=? AND status='completed' ORDER BY created_at DESC LIMIT 1",
            [cid, ctx.i.id],
          );
          const a = latest?.result ? JSON.parse(latest.result) : null;
          if (!a)
            throw new ApiError(
              409,
              "Request fresh Rocket1000 AI analysis before reviewing a trading proposal.",
              "AI_PLAN_REQUIRED",
            );
          if (kind === "OPEN") {
            intent = {
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
            };
            if (
              ["side", "symbol", "stop", "takeProfit", "maxLots"].some(
                (k) =>
                  input.order?.[k] !== undefined &&
                  input.order[k] !== intent[k],
              )
            )
              throw new ApiError(
                409,
                "Use the exact AI proposal. Manual strategy entries cannot override the AI decision.",
                "AI_PLAN_REQUIRED",
              );
          }
          const assessment = await verifyAiCommand(
            tx,
            ctx,
            intent,
            latest.id,
            now(),
          );
          provenance = {
            ...aiProvenance(assessment, latest.id),
            manualReview: true,
          };
        }
        const order = {
            ...orderRisk(ctx, { ...intent, ...provenance }),
            ...provenance,
          },
          id = randomUUID(),
          expiresAt = now() + 30000;
        await tx.query(
          "DELETE FROM rocket_order_previews WHERE connection_id=? AND expires_at<=?",
          [cid, now()],
        );
        await tx.query(
          "INSERT INTO rocket_order_previews(id,connection_id,installation_id,session_id,payload,expires_at) VALUES(?,?,?,?,?,?)",
          [
            id,
            cid,
            ctx.i.id,
            ctx.x.session_id,
            JSON.stringify(order),
            expiresAt,
          ],
        );
        return {
          id,
          order,
          expiresAt,
          serverTime: now(),
          account: {
            login: ctx.i.account_login,
            type: ctx.i.account_type,
            server: ctx.i.broker_server,
          },
        };
      }
      if (input?.action === "confirm") {
        if (
          typeof input.previewId !== "string" ||
          !idPattern.test(input.previewId)
        )
          throw new ApiError(400, "Invalid review.");
        const [prior] = await tx.query(
          "SELECT id,status FROM rocket_trade_commands WHERE preview_id=? AND connection_id=?",
          [input.previewId, cid],
        );
        if (prior) return prior;
        const [p] = await tx.query(
          "SELECT * FROM rocket_order_previews WHERE id=? AND connection_id=?",
          [input.previewId, cid],
        );
        if (
          !p ||
          Number(p.expires_at) <= now() ||
          p.installation_id !== ctx.i?.id ||
          p.session_id !== ctx.x?.session_id
        )
          throw new ApiError(
            409,
            "Trade review expired or the MT5 session changed. Review again.",
          );
        const reviewed = JSON.parse(p.payload);
        if (reviewed.source === "ai")
          await verifyAiCommand(tx, ctx, reviewed, reviewed.analysisId, now());
        const current = orderRisk(ctx, reviewed);
        if (reviewed.revision !== ctx.revision)
          throw new ApiError(409, "Risk settings changed. Review again.");
        if (
          current.volume < reviewed.volume ||
          ((reviewed.kind || "OPEN") === "OPEN" &&
            Math.abs(current.entry - reviewed.entry) >
              ctx.execution.point * reviewed.maxSlippage) ||
          (reviewed.kind !== "OPEN" && current.volume !== reviewed.volume) ||
          (reviewed.kind === "CLOSE" &&
            Math.abs(current.entry - reviewed.entry) >
              current.pricePoint * reviewed.maxSlippage)
        )
          throw new ApiError(
            409,
            "Price or risk changed. Review the trade again.",
          );
        const [pending] = await tx.query(
          "SELECT id FROM rocket_trade_commands WHERE connection_id=? AND status='queued' LIMIT 1",
          [cid],
        );
        if (pending)
          throw new ApiError(409, "Wait for the pending order to finish.");
        const id = randomUUID();
        await tx.query(
          "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
          [
            id,
            p.id,
            cid,
            ctx.i.id,
            ctx.x.session_id,
            JSON.stringify({ ...reviewed, engineVersion: ENGINE_VERSION }),
            "queued",
            now(),
            now() + 45000,
          ],
        );
        await tx.query(
          "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?)",
          [id, ctx.consent.key],
        );
        await audit("reviewed_order_confirmed");
        return { id, status: "queued" };
      }
      throw new ApiError(400, "Unknown trading action.");
    });
  }
  return { status, act };
}

export async function enqueueCommand(
  tx,
  ctx,
  order,
  key,
  now,
  { analysisId } = {},
) {
  const [prior] = await tx.query(
    "SELECT id,status FROM rocket_trade_commands WHERE connection_id=? AND preview_id=?",
    [ctx.c.id, key],
  );
  if (prior) return prior;
  const [pending] = await tx.query(
    "SELECT id FROM rocket_trade_commands WHERE connection_id=? AND status IN ('queued','claimed','sending','uncertain') AND id IN (SELECT command_id FROM rocket_command_accounts WHERE account_key=?) LIMIT 1",
    [ctx.c.id, ctx.consent.key],
  );
  if (pending) throw new ApiError(409, "A broker request is already pending.");
  const assessment = await verifyAiCommand(tx, ctx, order, analysisId, now);
  const provenance = aiProvenance(assessment, analysisId);
  const approved = orderRisk(ctx, { ...order, ...provenance }),
    id = randomUUID();
  await tx.query(
    "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
    [
      id,
      key,
      ctx.c.id,
      ctx.i.id,
      ctx.x.session_id,
      JSON.stringify({
        ...approved,
        ...provenance,
        originTerminal: ctx.execution.terminalId,
      }),
      "queued",
      now,
      now + 45000,
    ],
  );
  await tx.query(
    "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?)",
    [id, ctx.consent.key],
  );
  return { id, status: "queued" };
}

function aiProvenance(assessment, analysisId) {
  return {
    engineVersion: ENGINE_VERSION,
    source: "ai",
    analysisId,
    signalExpiresAt: assessment.expiresAt,
    signalBarTime: assessment.profile?.decisionBarTime,
    signalStrategy: assessment.strategy,
    signalConfidence: assessment.confidence,
  };
}

async function verifyAiCommand(
  tx,
  ctx,
  order,
  analysisId,
  now,
  commandId = null,
) {
  let assessment = null;
  if (analysisId) {
    const [row] = await tx.query(
      "SELECT result FROM rocket_analyses WHERE id=? AND connection_id=? AND installation_id=? AND status='completed'",
      [analysisId, ctx.c.id, ctx.i.id],
    );
    assessment = row?.result ? JSON.parse(row.result) : null;
    if (
      !assessment ||
      assessment.engineVersion !== ENGINE_VERSION ||
      assessment.settingsRevision !== ctx.revision ||
      assessment.symbol !== ctx.market.symbol ||
      !Number.isFinite(assessment.expiresAt) ||
      assessment.expiresAt <= now ||
      assessment.profile?.decisionBarTime !== decisionBar(ctx.market)
    )
      throw new ApiError(
        409,
        "AI assessment expired or its account/risk settings changed.",
      );
  }
  if (
    !assessment ||
    !isConfiguredModel(assessment.model, ctx.aiModel) ||
    !Array.isArray(assessment.positionActions)
  )
    throw new ApiError(
      409,
      "Every automatic command requires a fresh, explicit Rocket1000 AI plan.",
    );
  if (!ctx.analysisEngineActive)
    throw new ApiError(
      409,
      "Start the verified analysis engine before submitting AI commands. Stopped, interrupted or offline workers cannot authorize orders.",
      "AI_ENGINE_NOT_RUNNING",
    );
  const commands = await tx.query(
    "SELECT t.id,t.payload FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.connection_id=? AND a.account_key=? AND t.created_at>=?",
    [ctx.c.id, ctx.consent.key, now - 86400000],
  );
  if (
    commands.some((row) => {
      const prior = JSON.parse(row.payload);
      return (
        row.id !== commandId &&
        prior.analysisId === analysisId &&
        (prior.kind || "OPEN") === (order.kind || "OPEN") &&
        (prior.position || "") === (order.position || "")
      );
    })
  )
    throw new ApiError(
      409,
      "This AI position action or entry was already submitted. Wait for a new AI assessment.",
      "AI_PLAN_ALREADY_SUBMITTED",
    );
  if (
    (order.kind || "OPEN") === "OPEN" &&
    (!Number.isFinite(assessment.entryPrice) ||
      assessment.entryPrice <= 0 ||
      Math.abs(
        (order.side === "BUY" ? ctx.market.ask : ctx.market.bid) -
          assessment.entryPrice,
      ) >
        ctx.settings.maxSlippagePoints * ctx.execution.point)
  )
    throw new ApiError(
      409,
      "Broker price moved beyond the AI proposal's entry tolerance. Request fresh AI analysis.",
      "AI_ENTRY_PRICE_CHANGED",
    );
  if (
    (order.kind || "OPEN") === "OPEN" &&
    (!assessment ||
      assessment.decision !== order.side ||
      !Number.isFinite(assessment.proposedLots) ||
      assessment.proposedLots <= 0 ||
      order.maxLots > assessment.proposedLots + 1e-8 ||
      (ctx.market.positions.some((p) => p.symbol === ctx.market.symbol)
        ? assessment.entryAction !== "ADD"
        : assessment.entryAction !== "OPEN") ||
      Math.abs(order.stop - assessment.stopLoss) >
        ctx.execution.tickSize + 1e-8 ||
      Math.abs(order.takeProfit - assessment.takeProfit) >
        ctx.execution.tickSize + 1e-8)
  )
    throw new ApiError(
      409,
      "A matching, fresh structured AI assessment is required for an automatic entry.",
    );
  if ((order.kind || "OPEN") !== "OPEN") {
    const action = assessment.positionActions.find(
      (a) => a.position === order.position,
    );
    const close = order.kind === "CLOSE";
    if (
      !action ||
      (close
        ? order.partialClose === true
          ? action.kind !== "PARTIAL_CLOSE" ||
            Math.abs(action.volume - order.volume) > 1e-8
          : action.kind !== "CLOSE"
        : action.kind !== "MODIFY" ||
          Math.abs(action.stopLoss - order.stop) > 1e-8 ||
          Math.abs(action.takeProfit - order.takeProfit) > 1e-8)
    )
      throw new ApiError(
        409,
        "The AI plan does not authorize this exact position action.",
      );
  }
  if (
    !Number.isFinite(assessment.confidence) ||
    assessment.confidence > 1 ||
    assessment.confidence <
      (ctx.profile?.minConfidence || ctx.settings.minConfidence)
  )
    throw new ApiError(409, "AI confidence is below the configured minimum.");
  return assessment;
}

// Runs inside the credential/account-verified telemetry transaction, holding the connection lock.
export async function executionExchange(
  tx,
  i,
  input,
  now,
  { register = false, authorize = false } = {},
) {
  if (register) await disableTrading(tx, i.connection_id, now);
  if (authorize && ![3, 4].includes(input.eaProtocol))
    throw new ApiError(400, "Upgrade the EA before authorizing orders.");
  if (![3, 4].includes(input.eaProtocol))
    return { tradingEnabled: false, command: "NONE" };
  if (!sessionPattern.test(input.terminalSession || ""))
    throw new ApiError(422, "Invalid EA session.");
  const x = validateExecution({
    ...input.execution,
    protocol: input.eaProtocol,
  });
  if (input.eaProtocol === 4 && !x.terminalId)
    throw new ApiError(422, "A persistent terminal identity is required.");
  const [previous] = await tx.query(
    "SELECT * FROM rocket_execution WHERE connection_id=?",
    [i.connection_id],
  );
  if (
    register ||
    !previous ||
    previous.session_id !== input.terminalSession ||
    previous.installation_id !== i.id
  )
    await disableTrading(tx, i.connection_id, now);
  await tx.query(
    "INSERT INTO rocket_execution(connection_id,installation_id,session_id,payload,received_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET installation_id=excluded.installation_id,session_id=excluded.session_id,payload=excluded.payload,received_at=excluded.received_at",
    [i.connection_id, i.id, input.terminalSession, JSON.stringify(x), now],
  );
  const ack = input.orderResult;
  if (ack) {
    if (
      typeof ack.id !== "string" ||
      !idPattern.test(ack.id) ||
      typeof ack.lease !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(ack.lease) ||
      !["executed", "partial", "failed", "uncertain"].includes(ack.status) ||
      !Number.isInteger(ack.retcode) ||
      ack.retcode < 0 ||
      ack.retcode > 100000 ||
      typeof ack.deal !== "string" ||
      !/^\d{1,20}$/.test(ack.deal) ||
      typeof ack.order !== "string" ||
      !/^\d{1,20}$/.test(ack.order)
    )
      throw new ApiError(422, "Invalid broker acknowledgement.");
    const [request] = await tx.query(
      "SELECT t.payload FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.id=? AND t.connection_id=? AND a.account_key=?",
      [
        ack.id,
        i.connection_id,
        accountKey(input.accountLogin, input.brokerServer, input.accountType),
      ],
    );
    const requested = request ? JSON.parse(request.payload) : null;
    const kind = requested?.kind || "OPEN";
    let acknowledgedStatus = ack.status;
    const reconciled =
      ack.reconciled === true &&
      ack.retcode === 0 &&
      ack.evidence ===
        (kind === "MODIFY" ? "position-state" : "broker-history");
    if (
      ["executed", "partial"].includes(ack.status) &&
      ((!reconciled && ![10009, 10010].includes(ack.retcode)) ||
        (kind !== "MODIFY" && ack.deal === "0"))
    )
      throw new ApiError(422, "A confirmed broker deal is required.");
    if (
      input.eaProtocol === 4 &&
      ["executed", "partial"].includes(ack.status) &&
      kind !== "MODIFY" &&
      ![ack.filledVolume, ack.filledPrice].every(
        (v) => Number.isFinite(v) && v > 0,
      )
    )
      throw new ApiError(
        422,
        "Actual broker fill price and volume are required.",
      );
    if (
      input.eaProtocol === 4 &&
      requested &&
      kind !== "MODIFY" &&
      ["executed", "partial"].includes(ack.status)
    ) {
      const epsilon = Math.max(1e-8, requested.volume * 1e-8);
      if (ack.filledVolume > requested.volume + epsilon)
        throw new ApiError(
          422,
          "Broker fill exceeds the authorized command volume; reconcile before continuing.",
        );
      if (ack.filledVolume + epsilon < requested.volume)
        acknowledgedStatus = "partial";
    }
    await tx.query(
      "UPDATE rocket_trade_commands SET status=?,result=? WHERE id=? AND connection_id=? AND installation_id=? AND session_id=? AND lease_hash=? AND status IN ('claimed','sending','uncertain') AND id IN (SELECT command_id FROM rocket_command_accounts WHERE account_key=?)",
      [
        acknowledgedStatus,
        JSON.stringify({
          retcode: ack.retcode,
          deal: ack.deal,
          order: ack.order,
          partial: ack.retcode === 10010 || acknowledgedStatus === "partial",
          reconciled,
          evidence: reconciled ? ack.evidence : "broker-response",
          acknowledgedAt: now,
          ...(Number.isFinite(ack.filledVolume) &&
          Number.isFinite(ack.filledPrice)
            ? { filledVolume: ack.filledVolume, filledPrice: ack.filledPrice }
            : {}),
        }),
        ack.id,
        i.connection_id,
        i.id,
        input.terminalSession,
        hash(ack.lease),
        accountKey(input.accountLogin, input.brokerServer, input.accountType),
      ],
    );
  }
  if (
    ack &&
    input.accountType === "demo" &&
    ["executed", "partial"].includes(ack.status)
  )
    await recordDemoValidation(
      tx,
      i.connection_id,
      i.user_id,
      accountKey(input.accountLogin, input.brokerServer, input.accountType),
      now,
    );
  const ctx = await context(tx, i.connection_id, now);
  const envelope = (order) => ({
    ...order,
    accountLogin: input.accountLogin,
    brokerServer: input.brokerServer,
    accountType: input.accountType,
    liveConfirmed: ctx.consent.confirmed,
    demoValidated: ctx.demoValidation.passed,
    riskPerTradePct:
      Math.min(
        order.riskPercent || ctx.settings.riskPerTradePct,
        ctx.profile?.ready
          ? ctx.profile.effectiveRiskPct
          : ctx.settings.riskPerTradePct,
      ) || ctx.settings.riskPerTradePct,
    maxDailyLossPct: ctx.settings.maxDailyLossPct,
    maxDrawdownPct: ctx.settings.maxDrawdownPct,
    maxPositions: ctx.settings.maxPositions,
  });
  if (authorize) {
    const a = input.authorization;
    if (
      !a ||
      typeof a.id !== "string" ||
      typeof a.lease !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(a.lease)
    )
      throw new ApiError(400, "Order authorization required.");
    const [c] = await tx.query(
      "SELECT * FROM rocket_trade_commands WHERE id=? AND connection_id=? AND installation_id=? AND session_id=? AND lease_hash=? AND status='claimed' AND expires_at>? AND id IN (SELECT command_id FROM rocket_command_accounts WHERE account_key=?)",
      [
        a.id,
        i.connection_id,
        i.id,
        input.terminalSession,
        hash(a.lease),
        now,
        ctx.consent.key,
      ],
    );
    // This order itself is the unresolved claim. All other safety checks must still pass.
    ctx.blockers = ctx.blockers.filter(
      (b) => !b.startsWith("A previous order"),
    );
    ctx.unresolved = null;
    ctx.enabled = ctx.permissionActive && !ctx.blockers.length;
    if (!c) throw new ApiError(409, "Order lease expired or already consumed.");
    const reviewed = JSON.parse(c.payload);
    if (reviewed.source === "ai")
      await verifyAiCommand(tx, ctx, reviewed, reviewed.analysisId, now, c.id);
    const current = orderRisk(ctx, reviewed);
    if (reviewed.revision !== ctx.revision)
      throw new ApiError(409, "Risk settings changed after confirmation.");
    if (
      current.volume < reviewed.volume ||
      (reviewed.kind !== "OPEN" && reviewed.volume !== current.volume) ||
      (reviewed.kind === "CLOSE" &&
        Math.abs(current.entry - reviewed.entry) >
          current.pricePoint * reviewed.maxSlippage) ||
      ((reviewed.kind || "OPEN") === "OPEN" &&
        Math.abs(current.entry - reviewed.entry) >
          x.point * reviewed.maxSlippage)
    )
      throw new ApiError(409, "Broker price or risk changed.");
    await tx.query(
      "UPDATE rocket_trade_commands SET status='sending' WHERE id=?",
      [c.id],
    );
    return {
      tradingEnabled: true,
      command: "AUTHORIZED",
      orderId: c.id,
      lease: a.lease,
      ...envelope({ ...reviewed, entry: current.entry }),
      expiresAt: Number(c.expires_at),
    };
  }
  const wakeAutomation =
    input.eaProtocol === 4 &&
    ctx.permissionActive &&
    ctx.automation?.state === "running";
  if (input.eaProtocol === 4 && ctx.unresolved) {
    const [old] = await tx.query(
      "SELECT t.* FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.id=? AND a.account_key=? AND t.status='uncertain'",
      [ctx.unresolved.id, ctx.consent.key],
    );
    if (old) {
      const lease = randomBytes(32).toString("base64url");
      await tx.query(
        "UPDATE rocket_trade_commands SET installation_id=?,session_id=?,lease_hash=? WHERE id=?",
        [i.id, input.terminalSession, hash(lease), old.id],
      );
      return {
        tradingEnabled: false,
        command: "RECONCILE",
        orderId: old.id,
        lease,
        ...envelope(JSON.parse(old.payload)),
        createdAt: Number(old.created_at),
        expiresAt: now + 30000,
        wakeAutomation: false,
      };
    }
  }
  if (!ctx.permissionActive || ctx.unresolved)
    return { tradingEnabled: false, command: "NONE", wakeAutomation: false };
  const [c] = await tx.query(
    "SELECT * FROM rocket_trade_commands WHERE connection_id=? AND installation_id=? AND session_id=? AND status='queued' AND expires_at>? AND id IN (SELECT command_id FROM rocket_command_accounts WHERE account_key=?) ORDER BY created_at LIMIT 1",
    [i.connection_id, i.id, input.terminalSession, now, ctx.consent.key],
  );
  if (!c) return { tradingEnabled: true, command: "NONE", wakeAutomation };
  const intent = JSON.parse(c.payload);
  if ((intent.kind || "OPEN") === "OPEN" && !ctx.enabled)
    return { tradingEnabled: true, command: "NONE", wakeAutomation };
  const lease = randomBytes(32).toString("base64url");
  await tx.query(
    "UPDATE rocket_trade_commands SET status='claimed',lease_hash=?,claimed_at=? WHERE id=?",
    [hash(lease), now, c.id],
  );
  return {
    tradingEnabled: true,
    command: "TRADE",
    orderId: c.id,
    lease,
    ...envelope(intent),
    expiresAt: Number(c.expires_at),
  };
}
