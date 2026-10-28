import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, market, terminal, approveFixtureLive } from "./helpers.mjs";
import { engineService } from "../server/engine-service.mjs";
import { tradingService } from "../server/trading.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// In-memory protocol fixtures only. These tests never authenticate to a real
// provider or broker, grant production permission, or prove broker acceptance.
const SESSION = "0123456789abcdef01234567";
const execution = {
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
};
async function setup(type = "demo", patch = {}, keyConnected = true) {
  const f = await fixture();
  let identity = { ...terminal, accountType: type },
    session = SESSION,
    calls = 0;
  const send = (input = {}, register = false, nextSession = session) => {
    session = nextSession;
    return f.service.telemetry(
      f.token,
      {
        ...identity,
        accountTradeMode: identity.accountType === "demo" ? 0 : 2,
        eaProtocol: 4,
        terminalSession: session,
        execution: { ...execution, ...patch },
        market: market(f.now()),
        ...input,
      },
      register,
    );
  };
  await send({}, true);
  const engine = engineService(f.db, {
    now: f.now,
    credentials: {
      status: async () => ({
        configured: true,
        revision: "fixture",
        connection: { connected: keyConnected },
      }),
      test: async () => ({
        connected: keyConnected,
        error: "Fixture billing failure",
        errorCode: "AI_BILLING_REQUIRED",
      }),
      environment: async () => ({
        OPENAI_API_KEY: "fixture-not-an-actual-api-key",
        OPENAI_MODEL: "gpt-6.1-sol",
      }),
    },
    provider: async () => {
      calls++;
      return {
        status: "completed",
        id: "resp_fixture_not_real",
        model: "gpt-6.1-sol",
        usage: { input_tokens: 100, output_tokens: 50 },
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  decision: "WAIT",
                  confidence: 0.9,
                  strategy: "wait",
                  timeframe: "M1",
                  entryPrice: null,
                  stopLoss: null,
                  takeProfit: null,
                  proposedLots: null,
                  entryAction: "NONE",
                  positionActions: [],
                  reasoning: "Fixture WAIT; no confirmed opportunity",
                  risks: [],
                }),
              },
            ],
          },
        ],
      };
    },
  });
  const trade = tradingService(f.db, { now: f.now });
  const count = async (table) =>
    (await f.db.query(`SELECT * FROM ${table}`)).length;
  return {
    ...f,
    engine,
    trade,
    send,
    count,
    calls: () => calls,
    start: async () => {
      await engine.heartbeat();
      if (
        identity.accountType === "live" &&
        (await trade.status("alice")).connectionBlockers.length === 0
      )
        await approveFixtureLive(trade);
      return engine.start("alice");
    },
    switchAccount: async (next) => {
      identity = { ...identity, ...next };
      return send({}, true);
    },
  };
}

for (const type of ["demo", "live"]) {
  test(`${type}: authenticated connection alone grants no orders; unified START binds the exact account`, async () => {
    const f = await setup(type);
    try {
      assert.equal((await f.trade.status("alice")).permissionActive, false);
      assert.equal(await f.count("rocket_trade_policy"), 0);
      await assert.rejects(
        f.engine.start("alice"),
        (e) => e.code === "AI_SCHEDULER_NOT_READY",
      );
      await f.start();
      assert.equal((await f.trade.status("alice")).permissionActive, true);
      assert.equal((await f.engine.status("alice")).executionAuthorized, true);
      assert.equal(
        await f.count("rocket_engine_validation"),
        0,
        "No Demo-to-Live evidence is required by the unified workflow",
      );
      assert.equal(
        await f.count("rocket_live_consents"),
        type === "live" ? 1 : 0,
      );
      assert.equal(
        await f.count("rocket_trade_commands"),
        0,
        "Start cannot manufacture a trade",
      );
      await f.engine.cycle(f.id);
      assert.equal(f.calls(), 1);
      assert.equal(
        await f.count("rocket_trade_commands"),
        0,
        "WAIT cannot execute",
      );
    } finally {
      await f.db.close();
    }
  });

  test(`${type}: STOP survives re-registration and cannot resume itself`, async () => {
    const f = await setup(type);
    try {
      await f.start();
      await f.engine.stop("alice");
      await f.send({}, true, "abcdef0123456789abcdef01");
      await f.engine.cycle(f.id);
      assert.equal((await f.engine.status("alice")).state, "stopped");
      assert.equal((await f.trade.status("alice")).permissionActive, false);
      assert.equal(await f.count("rocket_trade_commands"), 0);
      assert.equal(f.calls(), 0);
    } finally {
      await f.db.close();
    }
  });

  test(`${type}: same-account/terminal reconnect resumes only an already-enabled run`, async () => {
    const f = await setup(type);
    try {
      await f.start();
      const [before] = await f.db.query(
        "SELECT run_id FROM rocket_analysis_engine WHERE connection_id=?",
        [f.id],
      );
      await f.send({}, true, "abcdef0123456789abcdef01");
      const [after] = await f.db.query(
        "SELECT run_id,session_id FROM rocket_analysis_engine WHERE connection_id=?",
        [f.id],
      );
      assert.equal(after.run_id, before.run_id);
      assert.equal(after.session_id, "abcdef0123456789abcdef01");
      assert.equal((await f.trade.status("alice")).permissionActive, true);
      assert.equal(await f.count("rocket_trade_commands"), 0);
    } finally {
      await f.db.close();
    }
  });

  test(`${type}: account switching invalidates old automation without carrying permissions`, async () => {
    const f = await setup(type);
    try {
      await f.start();
      await f.switchAccount({
        accountLogin: "22222222",
        brokerServer: "Other-Broker",
      });
      assert.equal((await f.trade.status("alice")).permissionActive, false);
      assert.equal(await f.count("rocket_trade_policy"), 0);
      await f.engine.cycle(f.id);
      assert.equal(f.calls(), 0);
      assert.equal(await f.count("rocket_trade_commands"), 0);
    } finally {
      await f.db.close();
    }
  });

  test(`${type}: real readiness failures cannot be bypassed by an account type label`, async () => {
    const f = await setup(type, { tradeAllowed: false });
    try {
      await assert.rejects(
        f.start(),
        (e) => e.code === "MT5_PERMISSIONS_REQUIRED",
      );
      assert.equal(await f.count("rocket_trade_policy"), 0);
    } finally {
      await f.db.close();
    }
  });
}

test("unavailable OpenAI billing prevents unified execution and leaves no command", async () => {
  const f = await setup("demo", {}, false);
  try {
    await assert.rejects(f.start(), (e) => e.code === "AI_BILLING_REQUIRED");
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(await f.count("rocket_trade_commands"), 0);
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});

test("returning to an approved Live account preserves its review without enabling either account automatically", async () => {
  const f = await setup("live");
  try {
    await f.start();
    const approved = await f.trade.status("alice");
    await f.switchAccount({
      accountLogin: "22222222",
      brokerServer: "Other-Live",
    });
    const other = await f.trade.status("alice");
    assert.equal(other.liveConfirmed, false);
    assert.equal(other.permissionActive, false);
    await f.switchAccount({
      accountLogin: terminal.accountLogin,
      brokerServer: terminal.brokerServer,
    });
    const returned = await f.trade.status("alice");
    assert.equal(returned.accountKey, approved.accountKey);
    assert.equal(returned.liveConfirmed, true);
    assert.equal(returned.permissionActive, false);
    await f.engine.start("alice");
    assert.equal((await f.trade.status("alice")).permissionActive, true);
    await f.service.stop("alice");
    assert.equal((await f.trade.status("alice")).liveConfirmed, false);
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});

test("a legacy consent without the exact current-engine review cannot authorize execution", async () => {
  const f = await setup("live");
  try {
    const state = await f.trade.status("alice");
    await f.db.query(
      "INSERT INTO rocket_live_consents(user_id,account_key,account_login,broker_server,confirmed_at) VALUES(?,?,?,?,?)",
      [
        "alice",
        state.accountKey,
        terminal.accountLogin,
        terminal.brokerServer,
        f.now(),
      ],
    );
    await f.engine.heartbeat();
    await assert.rejects(
      f.engine.start("alice"),
      (e) => e.code === "LIVE_AUTHORIZATION_REQUIRED",
    );
    const review = await f.trade.act("alice", { action: "prepare-live" });
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    await f.trade.act("alice", {
      action: "confirm-live",
      id: review.id,
      accountKey: review.accountKey,
    });
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    await f.engine.start("alice");
    assert.equal((await f.trade.status("alice")).permissionActive, true);
  } finally {
    await f.db.close();
  }
});

test("Emergency Stop revokes authorization independently of paid AI and leaves positions alone", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.service.stop("alice");
    await f.send({}, true);
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});

test("different persistent terminal cannot inherit or revoke the original reconnect authorization", async () => {
  const f = await setup();
  try {
    await f.start();
    const original = await f.db.query(
      "SELECT * FROM rocket_execution WHERE connection_id=?",
      [f.id],
    );
    await assert.rejects(
      f.send(
        { execution: { ...execution, terminalId: "abcdef0123456789abcdef01" } },
        true,
      ),
      (e) => e.code === "EA_CONNECTION_IN_USE",
    );
    assert.deepEqual(
      await f.db.query("SELECT * FROM rocket_execution WHERE connection_id=?", [
        f.id,
      ]),
      original,
    );
    assert.equal((await f.trade.status("alice")).permissionActive, true);
    assert.equal(await f.count("rocket_trade_policy"), 1);
    const heartbeat = await f.send();
    assert.equal(heartbeat.ok, true);
    assert.equal(heartbeat.command, "NONE");
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});
