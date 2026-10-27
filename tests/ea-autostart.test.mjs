import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, market, terminal, approveFixtureLive } from "./helpers.mjs";
import { engineService } from "../server/engine-service.mjs";
import { tradingService } from "../server/trading.mjs";
import { analysisQueue } from "../server/analysis-queue.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { ApiError } from "../server/errors.mjs";
import { accountKey } from "../server/trade-settings.mjs";

// Protocol and provider-response fixtures only. No network, credentials,
// production permissions, or genuine broker execution are exercised here.
const SESSION = "0123456789abcdef01234567";
const SECOND_SESSION = "abcdef0123456789abcdef01";
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
  positionsAvailable: true,
  positions: [],
};

async function setup(type = "demo", options = {}) {
  const f = await fixture();
  let identity = { ...terminal, accountType: type };
  let session = SESSION;
  let connected = options.keyConnected === true;
  let configured = options.keyConfigured !== false;
  let tests = 0;
  let providerCalls = 0;
  const env = {
    ...(options.queueMode ? { VERCEL: "1", ROCKET_QUEUE_ANALYSIS: "1" } : {}),
    OPENAI_API_KEY: "fixture-not-a-provider-key",
    OPENAI_MODEL: "gpt-6.1-sol",
  };
  const credentials = {
    status: async () => ({
      configured,
      revision: "fixture-key-revision",
      connection: { connected },
    }),
    test: async () => {
      tests++;
      const result = options.keyTest
        ? await options.keyTest()
        : { connected: true };
      connected = result.connected === true;
      return result;
    },
    environment: async () => env,
  };
  const provider = async () => {
    providerCalls++;
    if (options.provider) return options.provider();
    return {
      status: "completed",
      id: "resp_fixture_not_an_actual_openai_response",
      model: env.OPENAI_MODEL,
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
                reasoning: "Fixture WAIT; no confirmed opportunity.",
                risks: [],
              }),
            },
          ],
        },
      ],
    };
  };
  const engine = engineService(f.db, {
    now: f.now,
    env,
    credentials,
    provider,
  });
  const sent = [];
  const queue = analysisQueue(f.db, {
    now: f.now,
    env,
    engine,
    publish: async (...args) => {
      if (options.queueFailure) throw Error("Fixture queue unavailable");
      sent.push(args);
      return { messageId: "fixture" };
    },
  });
  const send = (patch = {}, register = false, nextSession = session) => {
    session = nextSession;
    return f.service.telemetry(
      f.token,
      {
        ...identity,
        accountTradeMode: identity.accountType === "demo" ? 0 : 2,
        eaProtocol: 4,
        terminalSession: session,
        execution: { ...execution, ...options.executionPatch },
        market: market(f.now()),
        ...patch,
      },
      register,
    );
  };
  await send({}, true);
  // This suite exercises automatic recovery of explicitly enabled sessions.
  // Fresh connections without this persisted ON intent are tested separately.
  if (options.autoEnabled !== false)
    await f.db.query(
      "INSERT INTO rocket_engine_activation(connection_id,paused,generation) VALUES(?,0,?)",
      [f.id, randomUUID()],
    );
  const trade = tradingService(f.db, { now: f.now });
  return {
    ...f,
    engine,
    queue,
    env,
    send,
    sent,
    trade,
    auto: () =>
      options.queueMode ? queue.autoStart("alice") : engine.autoStart("alice"),
    tests: () => tests,
    providerCalls: () => providerCalls,
    setKeyConfigured: (value) => {
      configured = value;
    },
    count: async (table) => (await f.db.query(`SELECT * FROM ${table}`)).length,
    row: async () =>
      (
        await f.db.query(
          "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
          [f.id],
        )
      )[0],
    switchAccount: async (patch, nextSession = SECOND_SESSION) => {
      identity = { ...identity, ...patch };
      return send({}, true, nextSession);
    },
  };
}

for (const type of ["demo", "live"]) {
  test(`${type}: connecting the EA cannot enable Auto Trading without an explicit ON action`, async () => {
    const f = await setup(type, { autoEnabled: false });
    try {
      await f.engine.heartbeat();
      await f.auto();
      assert.equal((await f.trade.status("alice")).permissionActive, false);
      assert.equal(
        (await f.engine.status("alice")).automaticActivation.paused,
        true,
      );
      assert.equal(f.tests(), 1);
      assert.equal(f.providerCalls(), 0);
      assert.equal((await f.engine.status("alice")).mode, "analysis");
      if (type === "live") await approveFixtureLive(f.trade);
      await f.engine.start("alice");
      assert.equal((await f.trade.status("alice")).permissionActive, true);
      assert.equal(
        (await f.engine.status("alice")).automaticActivation.paused,
        false,
      );
    } finally {
      await f.db.close();
    }
  });
  test(`${type}: authenticated EA readiness automatically starts one analysis-only engine run`, async () => {
    const f = await setup(type);
    try {
      await f.engine.heartbeat();
      await Promise.all([f.auto(), f.auto(), f.auto()]);
      const first = await f.row();
      assert.equal(first.state, "scheduled");
      assert.equal((await f.trade.status("alice")).permissionActive, false);
      assert.equal(f.tests(), 1);
      await Promise.all([f.auto(), f.auto(), f.auto()]);
      assert.equal((await f.row()).run_id, first.run_id);
      assert.equal(f.tests(), 1);
      assert.equal(await f.count("rocket_trade_policy"), 0);
      assert.equal(await f.count("rocket_live_consents"), 0);
      assert.equal(await f.count("rocket_trade_commands"), 0);
      await f.engine.cycle(f.id);
      assert.equal(f.providerCalls(), 1);
      assert.equal(await f.count("rocket_analyses"), 1);
      assert.equal(
        await f.count("rocket_trade_commands"),
        0,
        "WAIT is not an execution",
      );
    } finally {
      await f.db.close();
    }
  });
}

test("explicit Start revalidates an engine whose old execution policy is no longer valid", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.auto();
    const first = await f.row();
    await f.db.query("DELETE FROM rocket_trade_policy WHERE connection_id=?", [
      f.id,
    ]);
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    await f.engine.start("alice");
    assert.notEqual((await f.row()).run_id, first.run_id);
    assert.equal((await f.trade.status("alice")).permissionActive, true);
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});

test("automatic account switching invalidates the old policy and validates the exact new account", async () => {
  const f = await setup("demo");
  try {
    await f.engine.heartbeat();
    await f.auto();
    const first = await f.row();
    await f.switchAccount({
      accountLogin: "22222222",
      brokerServer: "Other-Broker",
      accountType: "live",
    });
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    await f.auto();
    const current = await f.row();
    assert.notEqual(current.run_id, first.run_id);
    assert.notEqual(current.account_key, first.account_key);
    assert.equal(current.session_id, SECOND_SESSION);
    const state = await f.trade.status("alice");
    assert.equal(state.account.login, "22222222");
    assert.equal(state.account.type, "live");
    assert.equal(state.permissionActive, false);
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});

test("automatic restart can monitor a reconciled owned position without opening another position", async () => {
  const f = await setup();
  try {
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        id,
        randomUUID(),
        f.id,
        f.token.split(".")[1],
        SESSION,
        JSON.stringify({ kind: "OPEN", symbol: "XAUUSD" }),
        "executed",
        f.now(),
        f.now() + 45000,
      ],
    );
    await f.db.query(
      "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?)",
      [id, accountKey(terminal.accountLogin, terminal.brokerServer, "demo")],
    );
    const position = {
      ticket: "9001",
      identifier: "9001",
      symbol: "XAUUSD",
      side: "BUY",
      volume: 0.01,
      open: 2099,
      currentPrice: 2100,
      stop: 2095,
      takeProfit: 2110,
      profit: 1,
      openedAt: f.now() - 60000,
      magic: 100061,
      comment: "R1000:" + id.slice(0, 24),
      ownedIntegrity: true,
    };
    await f.send({
      market: { ...market(f.now()), positions: [position] },
      execution: { ...execution, positions: [position], existingRisk: 4 },
    });
    await f.engine.heartbeat();
    await f.auto();
    assert.equal((await f.row()).state, "scheduled");
    const state = await f.trade.status("alice");
    assert.equal(state.permissionActive, false);
    assert.ok(
      state.blockers.some((reason) =>
        /^Maximum 1 open positions;/.test(reason),
      ),
    );
    await f.engine.cycle(f.id);
    assert.equal(f.providerCalls(), 1);
    assert.equal(
      await f.count("rocket_trade_commands"),
      1,
      "Only the seeded original position exists",
    );
  } finally {
    await f.db.close();
  }
});

test("an unrelated broker position cannot use the owned-position restart exception", async () => {
  const f = await setup();
  try {
    const position = {
      ticket: "9001",
      identifier: "9001",
      symbol: "XAUUSD",
      side: "BUY",
      volume: 0.01,
      open: 2099,
      currentPrice: 2100,
      stop: 2095,
      takeProfit: 2110,
      profit: 1,
      openedAt: f.now() - 60000,
      magic: 0,
      comment: "manual",
      ownedIntegrity: false,
    };
    await f.send({
      market: { ...market(f.now()), positions: [position] },
      execution: { ...execution, positions: [position], existingRisk: 4 },
    });
    await f.engine.heartbeat();
    await f.auto();
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(await f.count("rocket_trade_commands"), 0);
    assert.equal(f.tests(), 1);
    assert.equal(f.providerCalls(), 0);
  } finally {
    await f.db.close();
  }
});

for (const [label, options, prepare] of [
  ["missing OpenAI key", { keyConfigured: false }],
  ["MT5 Algo Trading disabled", { executionPatch: { tradeAllowed: false } }],
  [
    "unsupported EA engine",
    { executionPatch: { engineVersion: "rocket-ai-old" } },
  ],
  ["unverified execution costs", { executionPatch: { costsVerified: false } }],
  [
    "three consecutive broker losses",
    { executionPatch: { consecutiveLosses: 3 } },
  ],
  ["daily loss limit", { executionPatch: { dailyLoss: 200 } }],
  ["stale broker data", {}, (f) => f.advance(31000)],
]) {
  test(`automatic activation fails closed for ${label} without execution authorization`, async () => {
    const f = await setup("demo", options);
    try {
      await f.engine.heartbeat();
      if (prepare) prepare(f);
      await f.auto();
      assert.equal((await f.trade.status("alice")).permissionActive, false);
      assert.equal(await f.count("rocket_trade_policy"), 0);
      assert.equal(await f.count("rocket_trade_commands"), 0);
      assert.equal(
        f.tests(),
        [
          "missing OpenAI key",
          "unsupported EA engine",
          "stale broker data",
        ].includes(label)
          ? 0
          : 1,
      );
      assert.equal(f.providerCalls(), 0);
    } finally {
      await f.db.close();
    }
  });
}

test("an offline scheduler cannot grant automatic trading permission", async () => {
  const f = await setup();
  try {
    await f.auto();
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(f.tests(), 0);
    assert.equal(f.providerCalls(), 0);
  } finally {
    await f.db.close();
  }
});

test("automatic billing failures are reported and backed off across repeated heartbeats", async () => {
  const f = await setup("demo", {
    keyTest: async () => ({
      connected: false,
      errorCode: "AI_BILLING_REQUIRED",
      error: "Fixture credits exhausted",
    }),
  });
  try {
    await f.engine.heartbeat();
    await f.auto();
    assert.equal(f.tests(), 1);
    for (let i = 0; i < 8; i++) {
      f.advance(5000);
      await f.send();
      await f.auto();
    }
    assert.equal(
      f.tests(),
      1,
      "EA heartbeat must not cause a paid verification loop",
    );
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    assert.equal(await f.count("rocket_trade_commands"), 0);
    assert.equal(f.providerCalls(), 0);
    assert.match(
      (await f.engine.status("alice")).reason || "",
      /credits|billing/i,
    );
  } finally {
    await f.db.close();
  }
});

test("a model-cycle billing failure suspends execution with persisted retry backoff", async () => {
  const f = await setup("demo", {
    provider: async () => {
      throw new ApiError(
        503,
        "Fixture model billing unavailable",
        "AI_BILLING_REQUIRED",
      );
    },
  });
  try {
    await f.engine.heartbeat();
    await f.auto();
    await f.engine.cycle(f.id);
    const failed = await f.engine.status("alice");
    assert.equal(failed.state, "suspended");
    assert.equal(failed.executionAuthorized, false);
    assert.ok(failed.automaticAnalysis.nextAttempt >= f.now() + 299000);
    assert.equal(f.providerCalls(), 1);
    for (let i = 0; i < 8; i++) {
      f.advance(5000);
      await f.send();
      await f.auto();
    }
    assert.equal((await f.engine.status("alice")).state, "suspended");
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(await f.count("rocket_trade_commands"), 0);
    assert.equal(f.providerCalls(), 1);
    assert.equal(f.tests(), 1);
  } finally {
    await f.db.close();
  }
});

for (const action of ["pause-auto", "disable", "revoke-live"]) {
  test(`legacy ${action} control persists a pause and cannot automatically rearm`, async () => {
    const f = await setup();
    try {
      await f.engine.heartbeat();
      await f.auto();
      await f.trade.act("alice", { action });
      await f.send({}, true, SECOND_SESSION);
      await f.auto();
      await f.switchAccount({ accountLogin: "22222222", accountType: "live" });
      await f.auto();
      assert.equal(
        (await f.engine.status("alice")).automaticActivation.paused,
        true,
      );
      assert.equal((await f.trade.status("alice")).permissionActive, false);
      assert.equal(await f.count("rocket_trade_policy"), 0);
      assert.equal(await f.count("rocket_trade_commands"), 0);
      assert.equal(f.tests(), 1);
      assert.equal(f.providerCalls(), 0);
    } finally {
      await f.db.close();
    }
  });
}

for (const stop of ["stop-ai", "emergency"]) {
  test(`${stop} before the first engine run persists an explicit automatic-activation pause`, async () => {
    const f = await setup();
    try {
      await f.engine.heartbeat();
      if (stop === "stop-ai") await f.engine.stop("alice");
      else await f.service.stop("alice");
      await f.send();
      await f.auto();
      assert.equal(await f.count("rocket_trade_policy"), 0);
      assert.equal(f.tests(), 0);
      assert.equal((await f.trade.status("alice")).permissionActive, false);
    } finally {
      await f.db.close();
    }
  });

  test(`${stop} remains paused across heartbeat, reconnect and account switch`, async () => {
    const f = await setup();
    try {
      await f.engine.heartbeat();
      await f.auto();
      if (stop === "stop-ai") await f.engine.stop("alice");
      else await f.service.stop("alice");
      await f.send();
      await f.auto();
      await f.send({}, true, SECOND_SESSION);
      await f.auto();
      await f.switchAccount({ accountLogin: "22222222", accountType: "live" });
      await f.auto();
      assert.equal(await f.count("rocket_trade_policy"), 0);
      assert.equal((await f.trade.status("alice")).permissionActive, false);
      assert.equal(await f.count("rocket_trade_commands"), 0);
      assert.equal(f.tests(), 1);
      assert.equal(f.providerCalls(), 0);
    } finally {
      await f.db.close();
    }
  });
}

test("STOP during automatic OpenAI verification cancels the in-flight activation", async () => {
  let release, entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await setup("demo", {
    keyTest: async () => {
      entered();
      await waiting;
      return { connected: true };
    },
  });
  try {
    await f.engine.heartbeat();
    const automatic = f.auto();
    await started;
    await f.engine.stop("alice");
    release();
    await automatic;
    await f.send({}, true, SECOND_SESSION);
    await f.auto();
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(await f.count("rocket_trade_commands"), 0);
    assert.equal(f.tests(), 1);
  } finally {
    release();
    await f.db.close();
  }
});

test("only an explicit Start can resume the owner's persisted pause", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.auto();
    await f.engine.stop("alice");
    await f.auto();
    assert.equal(
      (await f.engine.status("alice")).automaticActivation.paused,
      true,
    );
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    await f.engine.start("alice");
    assert.equal(
      (await f.engine.status("alice")).automaticActivation.paused,
      false,
    );
    assert.equal((await f.trade.status("alice")).permissionActive, true);
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});

test("migration preserves a legacy explicit STOP without confusing the default stopped flag", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    await f.engine.stop("alice");
    // The previous release had an engine STOP but no activation-intent table row.
    await f.db.query(
      "DELETE FROM rocket_engine_activation WHERE connection_id=?",
      [f.id],
    );
    await f.auto();
    const state = await f.engine.status("alice");
    assert.equal(state.automaticActivation.paused, true);
    assert.equal(state.state, "stopped");
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    assert.equal(
      f.tests(),
      1,
      "Migration must not verify or restart the stopped engine",
    );
  } finally {
    await f.db.close();
  }
});

test("migration preserves legacy Emergency Stop audit evidence even before an engine row exists", async () => {
  const f = await setup("demo", { autoEnabled: false });
  try {
    await f.engine.heartbeat();
    await f.db.query(
      "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
      [f.id],
    );
    await f.db.query(
      "INSERT INTO rocket_direct_audit(id,user_id,connection_id,event,created_at) VALUES(?,?,?,?,?)",
      [
        randomUUID(),
        "alice",
        f.id,
        "emergency_stop_all_live_permissions_revoked",
        f.now(),
      ],
    );
    await f.auto();
    assert.equal(
      (await f.engine.status("alice")).automaticActivation.paused,
      true,
    );
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(f.tests(), 0);
  } finally {
    await f.db.close();
  }
});

test("a genuine queue callback activates and continues the engine without a browser", async () => {
  const f = await setup("demo", { queueMode: true });
  try {
    await f.auto();
    assert.equal(f.tests(), 0);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(f.sent.length, 1);
    const probe = f.sent[0][1];
    assert.equal(probe.runId, null);
    // Publishing alone is not proof of scheduler liveness.
    assert.equal((await f.engine.scheduler(f.id)).configured, false);
    await f.queue.consume(probe);
    assert.equal((await f.row()).state, "scheduled");
    assert.equal(f.tests(), 1);
    const next = f.sent.find(([, payload]) => payload.runId !== null);
    assert.ok(next, "The verified callback must schedule an actual engine run");
    await f.queue.consume(next[1]);
    assert.equal(f.providerCalls(), 1);
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});

test("automatic queue publication failure revokes any newly granted policy", async () => {
  const f = await setup("demo", { queueMode: true, queueFailure: true });
  try {
    await f.engine.heartbeat("queue", `queue:${f.id}:probe`);
    await f.auto();
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    assert.equal(await f.count("rocket_trade_policy"), 0);
    assert.equal(await f.count("rocket_trade_commands"), 0);
    assert.equal(f.providerCalls(), 0);
  } finally {
    await f.db.close();
  }
});

test("a durable worker discovers an eligible EA and starts monitoring without browser activity", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat("worker", "fixture-autostart-worker");
    await f.engine.drain({ limit: 1 });
    const row = await f.row();
    assert.ok(row, "Worker discovery must persist an engine run");
    assert.ok(["scheduled", "running"].includes(row.state));
    assert.equal((await f.trade.status("alice")).permissionActive, false);
    assert.equal(f.tests(), 1);
    assert.equal(await f.count("rocket_trade_commands"), 0);
  } finally {
    await f.db.close();
  }
});
