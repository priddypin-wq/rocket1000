import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  market,
  terminal,
  approveFixtureLive,
  seedAiEntryFixture,
  seedAnalysisEngineFixture,
} from "./helpers.mjs";
import { tradingService } from "../server/trading.mjs";
import { engineService } from "../server/engine-service.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// Isolated account/permission regression fixtures. These tests do not contact
// an AI provider or broker and cannot qualify a production Demo acceptance.
const execution = {
  engineVersion: ENGINE_VERSION,
  terminalId: "abcdef0123456789abcdef01",
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
  costsVerified: true,
  commissionPerLot: 0,
  consecutiveLosses: 0,
  consecutiveLossesVerified: true,
  newsVerified: true,
  newsBlocked: false,
};

async function setup(type = "demo") {
  const f = await fixture();
  const trade = tradingService(f.db, { now: f.now });
  let identity = { ...terminal, accountType: type };
  const input = (patch = {}) => ({
    ...identity,
    eaProtocol: 4,
    terminalSession: "0123456789abcdef01234567",
    execution,
    market: market(f.now()),
    ...patch,
  });
  const send = (patch = {}, register = false, options = {}) =>
    f.service.telemetry(f.token, input(patch), register, options);
  await send({}, true);
  await seedAnalysisEngineFixture(f);
  await f.db.query(
    "INSERT INTO rocket_engine_validation(user_id,engine_version,completed_at,evidence) VALUES(?,?,?,?)",
    [
      "alice",
      ENGINE_VERSION,
      f.now(),
      JSON.stringify({ fixtureOnly: true, purpose: "Settings account safety" }),
    ],
  );
  const state = () => trade.status("alice");
  const engine = engineService(f.db, {
    now: f.now,
    credentials: {
      status: async () => ({
        configured: true,
        revision: "fixture-only",
        connection: { connected: true },
      }),
      test: async () => ({ connected: true }),
      environment: async () => ({
        OPENAI_API_KEY: "fixture-not-an-api-key",
        OPENAI_MODEL: "gpt-6.1-sol",
      }),
    },
  });
  const start = async () => {
    await engine.heartbeat();
    return engine.start("alice");
  };
  const queue = async () => {
    await seedAiEntryFixture(f);
    const preview = await trade.act("alice", {
      action: "preview",
      order: {
        side: "BUY",
        symbol: "XAUUSD",
        stop: 2095.2,
        takeProfit: 2110.2,
        maxLots: 0.01,
      },
    });
    return trade.act("alice", { action: "confirm", previewId: preview.id });
  };
  return {
    ...f,
    trade,
    input,
    send,
    state,
    start,
    queue,
    switchAccount: async (patch, telemetry = {}) => {
      identity = { ...identity, ...patch };
      return send(telemetry, true);
    },
  };
}

for (const type of ["demo", "live"]) {
  test(`${type}: Settings reads and healthy heartbeats preserve the active run and account permissions`, async () => {
    const f = await setup(type);
    try {
      if (type === "live") await approveFixtureLive(f.trade);
      await f.start();
      const [before] = await f.db.query(
        "SELECT * FROM rocket_automation WHERE connection_id=?",
        [f.id],
      );
      const initial = await f.state();
      for (let count = 0; count < 3; count++) {
        f.advance(5000);
        const heartbeat = await f.send();
        assert.equal(heartbeat.tradingEnabled, true);
        assert.equal(heartbeat.command, "NONE");
        const [connection] = await f.service.list("alice");
        assert.equal(connection.status, "Connected");
        const current = await f.state();
        assert.equal(current.permissionActive, true);
        assert.equal(current.automation.state, "running");
        assert.equal(current.account.type, type);
        assert.equal(current.liveConfirmed, false);
        assert.equal(current.settingsRevision, initial.settingsRevision);
        assert.equal(current.liveConfirmedAt, initial.liveConfirmedAt);
      }
      const [after] = await f.db.query(
        "SELECT * FROM rocket_automation WHERE connection_id=?",
        [f.id],
      );
      assert.equal(after.run_id, before.run_id);
      assert.equal((await f.state()).orders.length, 0);
    } finally {
      await f.db.close();
    }
  });

  test(`${type}: AI OFF pauses queued orders, preserves account metadata and requires a separate Start`, async () => {
    const f = await setup(type);
    try {
      if (type === "live") await approveFixtureLive(f.trade);
      await f.start();
      await f.queue();
      const before = await f.state();
      assert.equal(before.orders[0].status, "queued");
      f.advance(1);
      await f.trade.act("alice", { action: "pause-auto" });
      let current = await f.state();
      assert.equal(current.permissionActive, false);
      assert.equal(current.enabled, false);
      assert.equal(current.automation.state, "stopped");
      assert.equal(current.orders[0].status, "cancelled");
      assert.equal(current.liveConfirmedAt, before.liveConfirmedAt);
      assert.equal(current.liveConfirmed, false);
      assert.equal(
        current.activationEvents[0].event,
        "automatic_trading_paused",
      );
      for (let count = 0; count < 2; count++) {
        f.advance(5000);
        const reply = await f.send();
        assert.equal(reply.tradingEnabled, false);
        assert.equal(reply.command, "NONE");
        await f.service.list("alice");
      }
      assert.equal((await f.state()).automation.state, "stopped");
      await f.start();
      current = await f.state();
      assert.equal(current.permissionActive, true);
      assert.equal(current.automation.state, "running");
      assert.equal(current.orders[0].status, "cancelled");
      assert.equal(current.orders.length, 1);
    } finally {
      await f.db.close();
    }
  });
}

test("AI OFF prevents authorization of a command already claimed by the EA", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.queue();
    const claimed = await f.send();
    assert.equal(claimed.command, "TRADE");
    await f.trade.act("alice", { action: "pause-auto" });
    await assert.rejects(
      f.send(
        { authorization: { id: claimed.orderId, lease: claimed.lease } },
        false,
        { authorize: true },
      ),
    );
    assert.equal((await f.state()).enabled, false);
    assert.notEqual((await f.state()).orders[0].status, "executed");
  } finally {
    await f.db.close();
  }
});

test("EA account switching synchronizes verified identity and financials and leaves a new Live account unauthorized", async () => {
  const f = await setup();
  try {
    await f.start();
    const oldAccountKey = (await f.state()).accountKey;
    await f.queue();
    const reply = await f.switchAccount(
      {
        accountLogin: "22222222",
        brokerServer: "New-Live",
        accountType: "live",
      },
      { market: { ...market(f.now()), balance: 25000, equity: 24990 } },
    );
    assert.equal(reply.tradingEnabled, false);
    assert.equal(reply.command, "NONE");
    const current = await f.state();
    assert.deepEqual(current.account, {
      login: "22222222",
      server: "New-Live",
      type: "live",
    });
    assert.equal(current.market.balance, 25000);
    assert.equal(current.market.equity, 24990);
    assert.notEqual(current.accountKey, oldAccountKey);
    assert.equal(current.liveConfirmed, false);
    assert.equal(current.permissionActive, false);
    assert.equal(current.automation.state, "stopped");
    assert.equal(current.orders.length, 0);
    const [connection] = await f.service.list("alice");
    assert.equal(connection.status, "Connected");
    assert.equal(connection.installation.accountType, "live");
    assert.equal(connection.installation.accountLogin, "22222222");
    await assert.rejects(
      f.trade.act("alice", { action: "start-auto", accountKey: oldAccountKey }),
      /account changed/,
    );
    await f.start();
    assert.equal((await f.state()).permissionActive, true);
    assert.notEqual((await f.state()).accountKey, oldAccountKey);
    const [old] = await f.db.query(
      "SELECT status FROM rocket_trade_commands WHERE connection_id=?",
      [f.id],
    );
    assert.equal(old.status, "cancelled");
  } finally {
    await f.db.close();
  }
});

test("healthy account balance/equity updates synchronize without pausing automatic trading", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.send({
      market: { ...market(f.now()), balance: 18600, equity: 18590 },
    });
    const current = await f.state();
    assert.equal(current.market.balance, 18600);
    assert.equal(current.market.equity, 18590);
    assert.equal(current.account.login, terminal.accountLogin);
    assert.equal(current.permissionActive, true);
    assert.equal(current.automation.state, "running");
  } finally {
    await f.db.close();
  }
});

test("an unverified account change heartbeat blocks new orders until valid re-registration", async () => {
  const f = await setup();
  try {
    await f.start();
    await assert.rejects(
      f.send({ accountLogin: "33333333" }),
      (error) => error.code === "ACCOUNT_MISMATCH",
    );
    const current = await f.state();
    assert.equal(current.enabled, false);
    assert.equal(current.permissionActive, false);
    assert.equal(current.automation.state, "stopped");
    const [connection] = await f.service.list("alice");
    assert.equal(connection.status, "Account Mismatch");
  } finally {
    await f.db.close();
  }
});

test("another browser workspace cannot pause an account's running automation", async () => {
  const f = await setup();
  try {
    await f.start();
    await assert.rejects(
      f.trade.act("bob", { action: "pause-auto" }),
      /Connect MT5/,
    );
    assert.equal((await f.state()).permissionActive, true);
    assert.equal((await f.state()).automation.state, "running");
  } finally {
    await f.db.close();
  }
});
