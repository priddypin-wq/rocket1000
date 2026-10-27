import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, market, terminal, approveFixtureLive } from "./helpers.mjs";
import { engineService, stopAnalysis } from "../server/engine-service.mjs";
import { tradingService } from "../server/trading.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// Isolated persisted-state fixtures. No genuine model, broker or permissions.
const SESSION = "0123456789abcdef01234567";
const execution = {
  engineVersion: ENGINE_VERSION,
  terminalId: SESSION,
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
async function setup(type = "demo") {
  const f = await fixture();
  let connected = true,
    identity = { ...terminal, accountType: type };
  const options = {
    now: f.now,
    credentials: {
      status: async () => ({
        configured: true,
        revision: "fixture",
        connection: { connected },
      }),
      test: async () => ({
        connected,
        error: "Fixture API unavailable",
        errorCode: "AI_BILLING_REQUIRED",
      }),
      environment: async () => ({
        OPENAI_API_KEY: "fixture-only-not-a-provider-key",
        OPENAI_MODEL: "gpt-6.1-sol",
      }),
    },
    provider: async () => {
      throw Error("No paid analysis is allowed in resume tests");
    },
  };
  const createEngine = () => engineService(f.db, options),
    engine = createEngine(),
    trade = tradingService(f.db, { now: f.now });
  const send = (patch = {}, register = false) =>
    f.service.telemetry(
      f.token,
      {
        ...identity,
        accountTradeMode: identity.accountType === "demo" ? 0 : 2,
        eaProtocol: 4,
        terminalSession: SESSION,
        execution,
        market: market(f.now()),
        ...patch,
      },
      register,
    );
  await send({}, true);
  await engine.heartbeat();
  const count = async (table) =>
    (await f.db.query(`SELECT * FROM ${table}`)).length;
  const start = async () => {
    if (type === "live") await approveFixtureLive(trade);
    return engine.start("alice");
  };
  const interrupt = () =>
    f.db.transaction(async (tx) => {
      await stopAnalysis(
        tx,
        f.id,
        f.now(),
        "Background scheduling interrupted.",
      );
      await tx.query(
        "UPDATE rocket_analysis_engine SET state='suspended' WHERE connection_id=?",
        [f.id],
      );
    });
  return {
    ...f,
    engine,
    trade,
    send,
    count,
    start,
    interrupt,
    createEngine,
    setConnected: (v) => (connected = v),
    switchAccount: async (patch) => {
      identity = { ...identity, ...patch };
      return send({}, true);
    },
  };
}

for (const type of ["demo", "live"]) {
  test(`${type}: the exact previously enabled account and terminal recover execution after a worker interruption`, async () => {
    const f = await setup(type);
    try {
      await f.start();
      const consentBefore = await f.count("rocket_live_consents");
      assert.equal(await f.count("rocket_execution_intent"), 1);
      await f.interrupt();
      assert.equal(await f.count("rocket_trade_policy"), 0);
      const restarted = f.createEngine();
      await restarted.heartbeat();
      const state = await restarted.autoStart("alice");
      assert.equal(state.state, "scheduled");
      assert.equal(state.mode, "execution");
      assert.equal(state.executionAuthorized, true);
      assert.equal(
        await f.count("rocket_live_consents"),
        consentBefore,
        "Recovery never creates new Live consent",
      );
      assert.equal(
        await f.count("rocket_trade_commands"),
        0,
        "Recovery authorizes eligible future decisions, not an order",
      );
    } finally {
      await f.db.close();
    }
  });
  for (const stop of ["stop", "emergency"])
    test(`${type}: ${stop} remains latched despite a persisted enabled intent`, async () => {
      const f = await setup(type);
      try {
        await f.start();
        if (stop === "stop") await f.engine.stop("alice");
        else await f.service.stop("alice");
        await f.send({}, true);
        await f.engine.heartbeat();
        const state = await f.engine.autoStart("alice");
        assert.equal(state.state, "stopped");
        assert.equal(state.executionAuthorized, false);
        assert.equal(state.automaticActivation.paused, true);
        assert.equal(await f.count("rocket_trade_policy"), 0);
      } finally {
        await f.db.close();
      }
    });
}

test("a new persistent terminal cannot reuse the prior enabled execution intent", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.interrupt();
    await f.send(
      { execution: { ...execution, terminalId: "abcdef0123456789abcdef01" } },
      true,
    );
    const state = await f.engine.autoStart("alice");
    assert.equal(state.executionAuthorized, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(state.mode, "analysis");
  } finally {
    await f.db.close();
  }
});

test("switching accounts cannot carry an enabled intent to the new identity", async () => {
  const f = await setup("live");
  try {
    await f.start();
    await f.switchAccount({
      accountLogin: "33333333",
      brokerServer: "Other-Broker",
    });
    const state = await f.engine.autoStart("alice");
    assert.equal(state.mode, "analysis");
    assert.equal(state.executionAuthorized, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});

test("an unresolved broker outcome blocks recovery until actual reconciliation marks it resolved", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.interrupt();
    const [install] = await f.db.query(
      "SELECT id FROM rocket_direct_installations WHERE connection_id=?",
      [f.id],
    );
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        id,
        randomUUID(),
        f.id,
        install.id,
        SESSION,
        "{}",
        "uncertain",
        f.now(),
        f.now() + 30000,
      ],
    );
    const state = await f.engine.autoStart("alice");
    assert.equal(state.executionAuthorized, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    // This state transition is test-fixture broker reconciliation evidence only.
    await f.db.query(
      "UPDATE rocket_trade_commands SET status='failed' WHERE id=?",
      [id],
    );
    assert.equal((await f.engine.autoStart("alice")).executionAuthorized, true);
    assert.equal(
      await f.count("rocket_trade_commands"),
      1,
      "The uncertain command was never retried",
    );
  } finally {
    await f.db.close();
  }
});

test("provider failure cannot resume trading even with valid persisted execution intent", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.interrupt();
    f.setConnected(false);
    const state = await f.engine.autoStart("alice");
    assert.equal(state.executionAuthorized, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(state.state, "suspended");
    assert.match(state.reason, /API unavailable/);
  } finally {
    await f.db.close();
  }
});

test("the operator Live disable remains stronger than a persisted account approval", async () => {
  const f = await setup("live"),
    prior = process.env.ROCKET_DISABLE_LIVE_ORDERS;
  try {
    await f.start();
    await f.interrupt();
    process.env.ROCKET_DISABLE_LIVE_ORDERS = "1";
    const state = await f.engine.autoStart("alice");
    assert.equal(state.executionAuthorized, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(state.mode, "execution");
    assert.equal(state.automaticActivation.paused, false);
    delete process.env.ROCKET_DISABLE_LIVE_ORDERS;
    assert.equal((await f.engine.autoStart("alice")).executionAuthorized, true);
    assert.equal(await f.count("rocket_live_consents"), 1);
  } finally {
    if (prior === undefined) delete process.env.ROCKET_DISABLE_LIVE_ORDERS;
    else process.env.ROCKET_DISABLE_LIVE_ORDERS = prior;
    await f.db.close();
  }
});

for (const type of ["demo", "live"]) {
  test(`${type}: temporary Algo Trading permission loss suspends policy but preserves the enabled intent`, async () => {
    const f = await setup(type);
    try {
      await f.start();
      await f.send({ execution: { ...execution, tradeAllowed: false } });
      const waiting = await f.engine.autoStart("alice");
      assert.equal(waiting.executionAuthorized, false);
      assert.equal(waiting.mode, "execution");
      assert.equal(waiting.automaticActivation.paused, false);
      assert.equal(await f.count("rocket_trade_policy"), 0);
      await f.send();
      const recovered = await f.engine.autoStart("alice");
      assert.equal(recovered.executionAuthorized, true);
      assert.equal(recovered.mode, "execution");
      assert.equal(await f.count("rocket_trade_commands"), 0);
    } finally {
      await f.db.close();
    }
  });
  test(`${type}: stale account data blocks policy and fresh verified data safely resumes the saved intent`, async () => {
    const f = await setup(type);
    try {
      await f.start();
      f.advance(31000);
      const waiting = await f.engine.autoStart("alice");
      assert.equal(waiting.executionAuthorized, false);
      assert.equal(waiting.mode, "execution");
      assert.equal(waiting.automaticActivation.paused, false);
      assert.equal(await f.count("rocket_trade_policy"), 0);
      await f.send();
      assert.equal(
        (await f.engine.autoStart("alice")).executionAuthorized,
        true,
      );
      assert.equal(await f.count("rocket_trade_commands"), 0);
    } finally {
      await f.db.close();
    }
  });
}

test("automatic analysis alone never creates an execution-intent record or grants a policy", async () => {
  const f = await setup();
  try {
    const state = await f.engine.autoStart("alice");
    assert.equal(state.mode, "analysis");
    assert.equal(state.executionAuthorized, false);
    assert.equal(await f.count("rocket_execution_intent"), 0);
    assert.equal(await f.count("rocket_trade_policy"), 0);
  } finally {
    await f.db.close();
  }
});

test("an expired worker lease replaces the run before execution recovery and never resubmits an order", async () => {
  const f = await setup();
  try {
    await f.start();
    const [before] = await f.db.query(
      "SELECT run_id FROM rocket_analysis_engine WHERE connection_id=?",
      [f.id],
    );
    await f.db.query(
      "UPDATE rocket_analysis_engine SET state='running',lease_until=? WHERE connection_id=?",
      [f.now() - 1, f.id],
    );
    const state = await f.engine.autoStart("alice");
    const [after] = await f.db.query(
      "SELECT run_id FROM rocket_analysis_engine WHERE connection_id=?",
      [f.id],
    );
    assert.equal(state.executionAuthorized, true);
    assert.notEqual(after.run_id, before.run_id);
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});
