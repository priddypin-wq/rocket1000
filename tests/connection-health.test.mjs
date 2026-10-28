import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectionHealth,
  CONNECTION_TIMEOUT_MS,
} from "../server/connection-health.mjs";
import { ordersDashboardService } from "../server/orders-dashboard.mjs";
import { analysisService } from "../server/analysis-service.mjs";
import { fixture, terminal, market, NOW } from "./helpers.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// Controlled broker packets only: these tests never contact MT5 or OpenAI.
function execution() {
  return {
    engineVersion: ENGINE_VERSION,
    terminalId: "0123456789abcdef01234567",
    tickSize: 0.01,
    tickValue: 1,
    point: 0.01,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 10,
    stopLevel: 10,
    dayStartEquity: 18432.81,
    dailyLoss: 0,
    peakEquity: 18432.81,
    existingRisk: 0,
    freeMargin: 18000,
    pendingOrders: 0,
    tradeAllowed: false,
    stopsVerified: true,
    newsVerified: false,
    newsBlocked: true,
    account: {
      balance: 18432.81,
      equity: 18425.63,
      currency: "USD",
      brokerName: "Fixture Broker",
      dailyProfitLoss: -7.18,
    },
  };
}

async function connected() {
  const f = await fixture();
  const input = {
    ...terminal,
    accountType: "demo",
    eaProtocol: 4,
    terminalSession: "0123456789abcdef01234567",
    instanceId: "0123456789abcdef01234567",
    chartSymbol: "XAUUSD",
    authorizedSymbols: ["XAUUSD"],
    market: market(f.now()),
    execution: execution(),
  };
  await f.service.telemetry(f.token, input, true);
  const orders = ordersDashboardService(f.db, { now: f.now });
  const analysis = analysisService(f.db, { now: f.now });
  const assertStatus = async (status, fresh) => {
    const [connection] = await f.service.list("alice");
    const dashboard = await orders.status("alice");
    const state = await analysis.status("alice");
    assert.equal(connection.status, status);
    assert.equal(dashboard.connection.status, status);
    assert.equal(dashboard.connection.fresh, fresh);
    if (state.market) assert.equal(state.market.fresh, fresh);
    assert.equal(dashboard.permissionActive, false);
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_policy")).length,
      0,
    );
  };
  return { ...f, input, orders, analysis, assertStatus };
}

test("one connection freshness deadline is shared by MT5, orders and analysis", async () => {
  const f = await connected();
  try {
    await f.assertStatus("Connected", true);
    f.advance(CONNECTION_TIMEOUT_MS);
    await f.assertStatus("Connected", true);
    f.advance(1);
    await f.assertStatus("Disconnected", false);
    const dashboard = await f.orders.status("alice");
    assert.equal(dashboard.account.balance, null);
    assert.deepEqual(dashboard.authorizedSymbols, []);
  } finally {
    await f.db.close();
  }
});

test("broker disconnection immediately makes the retained market snapshot stale everywhere", async () => {
  const f = await connected();
  try {
    await assert.rejects(
      f.service.telemetry(
        f.token,
        { ...f.input, brokerConnected: false },
        false,
      ),
      (error) => error.code === "BROKER_DISCONNECTED",
    );
    await f.assertStatus("Disconnected", false);
    assert.ok((await f.analysis.status("alice")).market);
  } finally {
    await f.db.close();
  }
});

test("an old quote cannot become fresh merely because it arrived recently", async () => {
  const f = await connected();
  try {
    await f.service.telemetry(
      f.token,
      { ...f.input, market: market(f.now() - 29000) },
      false,
    );
    f.advance(2001);
    const [connection] = await f.service.list("alice");
    const state = await f.analysis.status("alice");
    const orders = await f.orders.status("alice");
    assert.equal(connection.status, "Connected");
    assert.equal(orders.connection.status, "Connected");
    assert.equal(state.market.fresh, false);
    assert.equal(orders.authorizedSymbols[0].fresh, false);
    assert.equal(orders.authorizedSymbols[0].bid, null);
    assert.equal(orders.permissionActive, false);
  } finally {
    await f.db.close();
  }
});

for (const [label, update, params, status] of [
  [
    "credential revocation",
    "UPDATE rocket_direct_installations SET revoked_at=? WHERE connection_id=?",
    [NOW],
    "Authentication Failed",
  ],
  [
    "credential expiration",
    "UPDATE rocket_direct_installations SET expires_at=? WHERE connection_id=?",
    [NOW],
    "Authentication Failed",
  ],
  [
    "account mismatch",
    "UPDATE rocket_direct_installations SET last_error=? WHERE connection_id=?",
    ["ACCOUNT_MISMATCH"],
    "Account Mismatch",
  ],
  [
    "malformed broker state",
    "UPDATE rocket_execution SET payload=? WHERE connection_id=?",
    ["{"],
    "Disconnected",
  ],
  [
    "another installation's state",
    "UPDATE rocket_execution SET installation_id=? WHERE connection_id=?",
    ["another-installation"],
    "Disconnected",
  ],
  [
    "stale execution with a recent heartbeat",
    "UPDATE rocket_execution SET received_at=? WHERE connection_id=?",
    [NOW - CONNECTION_TIMEOUT_MS - 1],
    "Disconnected",
  ],
  [
    "future execution timestamp",
    "UPDATE rocket_execution SET received_at=? WHERE connection_id=?",
    [NOW + 60000],
    "Disconnected",
  ],
]) {
  test(`${label} cannot appear connected on another page`, async () => {
    const f = await connected();
    try {
      await f.db.query(update, [...params, f.id]);
      await f.assertStatus(status, false);
    } finally {
      await f.db.close();
    }
  });
}

test("malformed or previous-installation market data is never advertised as live", async () => {
  const f = await connected();
  try {
    await f.db.query(
      "UPDATE rocket_market_snapshots SET payload=? WHERE connection_id=?",
      ["{", f.id],
    );
    assert.equal((await f.analysis.status("alice")).market, null);
    await f.db.query(
      "UPDATE rocket_market_snapshots SET payload=?,installation_id=? WHERE connection_id=?",
      [JSON.stringify(market(f.now())), "old-installation", f.id],
    );
    assert.equal((await f.analysis.status("alice")).market, null);
    assert.deepEqual(
      (await f.orders.status("alice")).authorizedSymbols.map((s) => [
        s.bid,
        s.ask,
        s.fresh,
      ]),
      [[null, null, false]],
    );
  } finally {
    await f.db.close();
  }
});

test("a legacy authenticated heartbeat remains a connection without granting execution", () => {
  const c = {
    expected_login: "1",
    expected_server: "Broker",
    expected_type: "demo",
  };
  const i = {
    id: "install",
    registered_at: NOW,
    last_heartbeat: NOW,
    expires_at: NOW + 100000,
    revoked_at: null,
    last_error: null,
    account_login: "1",
    broker_server: "Broker",
    account_type: "demo",
  };
  const health = connectionHealth(c, i, null, NOW);
  assert.equal(health.status, "Connected");
  assert.equal(health.execution, null);
  assert.equal(
    connectionHealth(c, { ...i, last_heartbeat: NOW + 60000 }, null, NOW)
      .status,
    "Disconnected",
  );
  assert.equal(
    connectionHealth({ ...c, expected_login: "2" }, i, null, NOW).status,
    "Disconnected",
  );
});
