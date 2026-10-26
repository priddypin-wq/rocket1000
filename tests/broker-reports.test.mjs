import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, terminal, market } from "./helpers.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import {
  privateReportService,
  privateReportResponse,
  csvCell,
} from "../server/report-export.mjs";
import { candleGeometry, chartIsFresh } from "../lib/broker-chart.mjs";

async function setup() {
  const f = await fixture();
  const x = {
    engineVersion: ENGINE_VERSION,
    terminalId: "0123456789abcdef01234567",
    tickSize: 0.01,
    tickValue: 1,
    point: 0.01,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 10,
    stopLevel: 10,
    freezeLevel: 0,
    dayStartEquity: 18432.81,
    dailyLoss: 7.18,
    peakEquity: 18432.81,
    existingRisk: 0,
    freeMargin: 18000,
    pendingOrders: 0,
    tradeAllowed: true,
    stopsVerified: true,
    newsVerified: true,
    newsBlocked: false,
    costsVerified: true,
    commissionPerLot: 0,
    consecutiveLosses: 0,
    consecutiveLossesVerified: true,
    positionsAvailable: true,
    positions: [],
    brokerPendingAvailable: true,
    brokerPending: [],
    account: {
      balance: 18432.81,
      equity: 18425.63,
      currency: "USD",
      brokerName: "Fixture Broker",
      dailyProfitLoss: -7.18,
      margin: 200,
      freeMargin: 18225.63,
      marginLevel: 9212.815,
      floatingProfit: -7.18,
      positionsCount: 0,
      ordersCount: 0,
    },
  };
  const s = market(f.now());
  s.symbol = "XAUUSDm";
  await f.service.telemetry(
    f.token,
    {
      ...terminal,
      accountType: "demo",
      eaProtocol: 4,
      accountTradeMode: 0,
      terminalSession: "0123456789abcdef01234567",
      execution: x,
      market: s,
    },
    true,
  );
  return {
    ...f,
    report: () => privateReportService(f.db, { now: f.now }).create("alice"),
  };
}

test("private chart/report preserves actual fixture OHLC and exact EA suffix; no visitor data or secrets", async () => {
  const f = await setup();
  try {
    const r = await f.report();
    assert.equal(r.chart.symbol, "XAUUSDm");
    assert.equal(r.account.login, terminal.accountLogin);
    assert.deepEqual(r.chart.timeframes.M5.bars, market(f.now()).bars);
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.history, []);
    assert.equal(r.historyComplete, false);
    assert.ok(!JSON.stringify(r).includes(f.token));
    assert.ok(!JSON.stringify(r).includes("installation_id"));
    const visitor = await privateReportService(f.db, { now: f.now }).create(
      "unknown-owner",
    );
    assert.equal(visitor.account, null);
    assert.equal(visitor.chart, null);
    assert.deepEqual(visitor.positions, []);
    const json = privateReportResponse(
      new Request("https://app.example/api/mt5/reports?format=json"),
      r,
    );
    assert.ok(json.headers.get("cache-control").includes("no-store"));
    assert.equal(json.headers.get("vary"), "Cookie");
    const csv = privateReportResponse(
      new Request("https://app.example/api/mt5/reports?format=csv"),
      r,
    );
    assert.ok(csv.headers.get("content-disposition").includes("attachment"));
    assert.ok((await csv.text()).includes("XAUUSDm"));
    assert.throws(() =>
      privateReportResponse(
        new Request("https://app.example/api/mt5/reports?token=secret"),
        r,
      ),
    );
  } finally {
    await f.db.close();
  }
});

test("stale or mismatched installation/account/session data cannot become a current broker chart", async () => {
  const f = await setup();
  try {
    const good = await f.report();
    assert.equal(chartIsFresh(good, 0), true);
    assert.equal(chartIsFresh(good, 31000), false);
    for (const [sql, params] of [
      [
        "UPDATE rocket_ea_symbols SET symbol=? WHERE connection_id=?",
        ["EURUSD", f.id],
      ],
      [
        "UPDATE rocket_ea_symbols SET session_id=? WHERE connection_id=?",
        ["different-session", f.id],
      ],
    ]) {
      await f.db.query(sql, params);
      assert.equal((await f.report()).chart, null);
    }
    f.advance(31000);
    const old = await f.report();
    assert.equal(old.chart, null);
    assert.equal(old.account.balance, null);
    assert.ok(old.summary.includes("fresh: no"));
  } finally {
    await f.db.close();
  }
});

test("CSV neutralizes formula/control-leading text while retaining actual numeric losses", () => {
  for (const text of [
    '=WEBSERVICE("bad")',
    "+SUM(1)",
    "-1+2",
    "@SUM(A1)",
    "  =1",
    "\tcmd",
    "\nformula",
  ])
    assert.ok(csvCell(text).startsWith("\"'"));
  assert.equal(csvCell(-12.34), '"-12.34"');
  assert.equal(csvCell("XAUUSDm"), '"XAUUSDm"');
  assert.equal(csvCell('a"b'), '"a""b"');
});

test("chart geometry keeps reported gaps/prices and refuses missing or corrupt candles", async () => {
  const f = await setup();
  try {
    const r = await f.report(),
      g = candleGeometry(r.chart, "M5");
    assert.equal(g.candles.length, 80);
    assert.deepEqual(
      g.candles.map(({ open, high, low, close, time }) => ({
        open,
        high,
        low,
        close,
        time,
      })),
      r.chart.timeframes.M5.bars
        .slice(-80)
        .map(({ open, high, low, close, time }) => ({
          open,
          high,
          low,
          close,
          time,
        })),
    );
    assert.equal(candleGeometry(r.chart, "D1"), null);
    const bad = structuredClone(r.chart);
    bad.timeframes.M5.bars.at(-1).close = NaN;
    assert.equal(candleGeometry(bad, "M5"), null);
  } finally {
    await f.db.close();
  }
});
