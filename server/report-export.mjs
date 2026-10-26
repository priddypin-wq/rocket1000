import { ApiError } from "./errors.mjs";
import { ordersDashboardService } from "./orders-dashboard.mjs";
import { validateSnapshot, TIMEFRAMES } from "./market.mjs";
import { accountKey } from "./trade-settings.mjs";
import { responseHeaders } from "./http.mjs";

const pick = (value, fields) =>
  Object.fromEntries(fields.map((field) => [field, value[field] ?? null]));
const sameAccount = (a, b) =>
  a && b && a.login === b.login && a.server === b.server && a.type === b.type;

// A fresh quote alone cannot prove a chart's provenance. Bind every candle to
// the private workspace, current installation, account and registered session.
export async function authenticatedBrokerChart(
  db,
  uid,
  now = Date.now(),
  expectedKey,
) {
  const [row] = await db.query(
    `SELECT c.expected_login,c.expected_server,c.expected_type,
      i.id AS installation_id,i.account_login,i.broker_server,i.account_type,
      i.registered_at,i.last_heartbeat,i.last_error,i.expires_at,
      e.installation_id AS execution_installation,e.session_id,e.received_at AS execution_received,
      r.installation_id AS symbol_installation,r.session_id AS symbol_session,r.account_key,r.symbol,
      m.installation_id AS market_installation,m.payload,m.received_at
      FROM rocket_direct_connections c
      JOIN rocket_direct_installations i ON i.connection_id=c.id AND i.revoked_at IS NULL
      JOIN rocket_execution e ON e.connection_id=c.id
      JOIN rocket_ea_symbols r ON r.connection_id=c.id
      JOIN rocket_market_snapshots m ON m.connection_id=c.id
      WHERE c.user_id=? ORDER BY i.created_at DESC LIMIT 1`,
    [uid],
  );
  if (!row) return null;
  const key = accountKey(
    row.expected_login,
    row.expected_server,
    row.expected_type,
  );
  const recent = (value) => {
    const age = now - Number(value);
    return value !== null && Number.isFinite(age) && age >= 0 && age <= 30_000;
  };
  if (
    (expectedKey && expectedKey !== key) ||
    !row.registered_at ||
    row.last_error ||
    Number(row.expires_at) <= now ||
    row.account_login !== row.expected_login ||
    row.broker_server !== row.expected_server ||
    row.account_type !== row.expected_type ||
    row.account_key !== key ||
    row.execution_installation !== row.installation_id ||
    row.symbol_installation !== row.installation_id ||
    row.market_installation !== row.installation_id ||
    row.symbol_session !== row.session_id ||
    !row.session_id ||
    !recent(row.last_heartbeat) ||
    !recent(row.execution_received) ||
    !recent(row.received_at)
  )
    return null;
  let market;
  try {
    market = validateSnapshot(JSON.parse(row.payload), now);
  } catch {
    return null;
  }
  if (market.symbol !== row.symbol) return null;
  // Root M5 is itself reported and validated; other choices exist only when
  // the EA actually supplies them. No interpolation or additional symbols.
  const timeframes = Object.fromEntries(
    Object.keys(TIMEFRAMES)
      .filter((name) => name === "M5" || market.timeframes?.[name])
      .map((name) => [
        name,
        { bars: name === "M5" ? market.bars : market.timeframes[name].bars },
      ]),
  );
  return {
    source: "Authenticated MT5 EA",
    symbol: market.symbol,
    bid: market.bid,
    ask: market.ask,
    timestamp: market.timestamp,
    brokerTimestamp: market.brokerTimestamp,
    quoteTimestamp: market.quoteTimestamp,
    receivedAt: Number(row.received_at),
    freshUntil:
      Math.min(
        Number(row.last_heartbeat),
        Number(row.execution_received),
        Number(row.received_at),
        market.timestamp,
      ) + 30_000,
    closedCandles: true,
    timeframes,
  };
}

export function privateReportService(db, { now = Date.now } = {}) {
  async function create(uid) {
    const status = await ordersDashboardService(db, { now }).status(uid);
    const account = status.account
      ? pick(status.account, [
          "login",
          "server",
          "type",
          "currency",
          "balance",
          "equity",
          "dailyProfitLoss",
          "brokerName",
          "margin",
          "freeMargin",
          "marginLevel",
          "floatingProfit",
          "positionsCount",
          "ordersCount",
          "tradingAllowed",
        ])
      : null;
    const report = {
      version: 1,
      generatedAt: now(),
      scope:
        "Current authenticated account; verified Rocket1000 positions and up to 100 broker deals",
      historyComplete: false,
      connection: {
        status: status.connection.status,
        fresh: status.connection.fresh,
        lastHeartbeat: status.connection.lastHeartbeat,
      },
      account,
      chart: account
        ? await authenticatedBrokerChart(db, uid, now(), status.accountKey)
        : null,
      positions: status.positions
        .filter((p) => sameAccount(p.account, account))
        .map((p) =>
          pick(p, [
            "ticket",
            "identifier",
            "symbol",
            "side",
            "volume",
            "open",
            "currentPrice",
            "stop",
            "takeProfit",
            "profit",
            "openedAt",
            "receivedAt",
            "fresh",
            "status",
          ]),
        ),
      brokerPending: status.brokerPending.map((p) =>
        pick(p, [
          "ticket",
          "symbol",
          "side",
          "volume",
          "price",
          "stop",
          "takeProfit",
          "createdAt",
          "status",
        ]),
      ),
      history: status.history.map((d) =>
        pick(d, [
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
        ]),
      ),
      performance: pick(status.performance, [
        "available",
        "scope",
        "from",
        "to",
        "currency",
        "closedDeals",
        "wins",
        "losses",
        "netProfit",
      ]),
    };
    return { ...report, summary: reportSummary(report) };
  }
  return { create };
}

const iso = (value) =>
  Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : "Not reported";
const number = (value) =>
  Number.isFinite(value) ? String(value) : "Not reported";
export function reportSummary(report) {
  const a = report.account;
  return [
    "ROCKET1000 private broker report",
    `Generated: ${iso(report.generatedAt)}`,
    `Connection: ${report.connection.status}; fresh: ${report.connection.fresh ? "yes" : "no"}`,
    a
      ? `Account: ${a.login} | ${a.server} | ${a.type}`
      : "Account: Not reported",
    a
      ? `Balance: ${number(a.balance)} ${a.currency || ""}; equity: ${number(a.equity)} ${a.currency || ""}`
      : "Balance / equity: Not reported",
    report.chart
      ? `Symbol: ${report.chart.symbol}; bid: ${report.chart.bid}; ask: ${report.chart.ask}; broker quote: ${iso(report.chart.quoteTimestamp)}`
      : "Quotes and chart: Waiting for fresh authenticated EA data",
    `Verified owned positions: ${report.positions.length}; broker pending: ${report.brokerPending.length}`,
    `Verified broker deals in sample: ${report.history.length}; history is limited to the most recent 100 owned deals, not a complete account statement.`,
    report.performance.available
      ? `Sample net P/L: ${number(report.performance.netProfit)} ${report.performance.currency || ""}`
      : "Sample performance: Unavailable",
    ...report.positions.map(
      (p) =>
        `Position ${p.ticket}: ${p.symbol} ${p.side} ${p.volume} lots; entry ${p.open}; P/L ${p.profit}; ${p.fresh ? p.status : "Requires attention (last reported)"}`,
    ),
    "Source: authenticated MT5 EA telemetry and ownership-verified broker history.",
  ].join("\n");
}

// Quoting CSV is insufficient: spreadsheet applications evaluate formulas in
// quoted fields too. Prefix all formula/control-leading strings before quoting.
export function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (
    typeof value === "string" &&
    (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text))
  )
    text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function reportCsv(report) {
  const rows = [["section", "record", "field", "value"]];
  function fields(section, record, value) {
    for (const [key, entry] of Object.entries(value))
      rows.push([
        section,
        record,
        key,
        typeof entry === "object" && entry !== null
          ? JSON.stringify(entry)
          : entry,
      ]);
  }
  fields("report", "", {
    generatedAt: iso(report.generatedAt),
    scope: report.scope,
    historyComplete: false,
  });
  fields("connection", "", report.connection);
  if (report.account) fields("account", "", report.account);
  fields("performance", "", report.performance);
  report.positions.forEach((p, i) => fields("position", i + 1, p));
  report.brokerPending.forEach((p, i) => fields("broker_pending", i + 1, p));
  report.history.forEach((d, i) => fields("broker_deal", i + 1, d));
  if (report.chart) {
    const { timeframes, ...quote } = report.chart;
    fields("quote", "", quote);
    for (const [timeframe, frame] of Object.entries(timeframes))
      frame.bars.forEach((bar) =>
        fields("closed_candle", `${timeframe}:${bar.time}`, {
          timeframe,
          ...bar,
        }),
      );
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function privateReportResponse(request, report) {
  const params = new URL(request.url).searchParams;
  const format = params.get("format") || "json";
  if (
    !["json", "csv"].includes(format) ||
    [...params.keys()].some((key) => !["format", "download"].includes(key)) ||
    params.getAll("format").length > 1 ||
    params.getAll("download").length > 1 ||
    (params.has("download") && params.get("download") !== "1")
  )
    throw new ApiError(
      400,
      "Choose a private JSON or CSV report.",
      "REPORT_FORMAT_INVALID",
    );
  const headers = { ...responseHeaders, Vary: "Cookie" };
  if (format === "csv" || params.get("download") === "1")
    headers["Content-Disposition"] =
      `attachment; filename="rocket1000-report-${new Date(report.generatedAt).toISOString().slice(0, 10)}.${format}"`;
  return format === "json"
    ? Response.json(report, { headers })
    : new Response("\uFEFF" + reportCsv(report), {
        headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
      });
}
