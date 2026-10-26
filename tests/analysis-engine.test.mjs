import { test } from "node:test";
import assert from "node:assert/strict";
import { engineService } from "../server/engine-service.mjs";
import { ApiError } from "../server/errors.mjs";
import { fixture, market, terminal } from "./helpers.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { tradeContext, tradingService } from "../server/trading.mjs";
import { openaiCredentialService } from "../server/openai-credentials.mjs";
import { credentialChanged } from "../server/engine-service.mjs";

// These are explicitly injected transport/terminal fixtures, never genuine
// broker execution or evidence qualifying an engine for Live activation.
const execution = {
  engineVersion: ENGINE_VERSION,
  tickSize: 0.01,
  tickValue: 1,
  point: 0.01,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 10,
  stopLevel: 10,
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
  terminalId: "0123456789abcdef01234567",
};
const assessment = {
  decision: "WAIT",
  confidence: 0.6,
  strategy: "wait",
  timeframe: "M1",
  entryPrice: null,
  stopLoss: null,
  takeProfit: null,
  proposedLots: null,
  entryAction: "NONE",
  positionActions: [],
  reasoning: "Fixture: no confirmed setup.",
  risks: ["Fixture only"],
};
function response() {
  return {
    status: "completed",
    id: "resp_fixture_not_real",
    model: "gpt-6.1-sol",
    usage: { input_tokens: 100, output_tokens: 50 },
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(assessment) }],
      },
    ],
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup({
  type = "demo",
  credentials: customKeys,
  provider: customProvider,
  executionPatch = {},
} = {}) {
  const f = await fixture();
  let calls = 0;
  const env = {
    OPENAI_API_KEY: "sk-fixture-not-an-actual-provider-key",
    OPENAI_MODEL: "gpt-6.1-sol",
  };
  const keys = customKeys || {
    status: async () => ({
      configured: true,
      revision: "fixture-r1",
      connection: { connected: true },
    }),
    test: async () => ({ connected: true }),
    environment: async () => env,
  };
  const engine = engineService(f.db, {
    now: f.now,
    env,
    credentials: keys,
    provider: async (...args) => {
      calls++;
      return customProvider ? customProvider(...args) : response();
    },
  });
  const send = (session = "0123456789abcdef01234567", register = false) =>
    f.service.telemetry(
      f.token,
      {
        ...terminal,
        accountType: type,
        accountTradeMode: type === "demo" ? 0 : 2,
        eaProtocol: 4,
        terminalSession: session,
        execution: { ...execution, ...executionPatch },
        market: market(f.now()),
      },
      register,
    );
  await send(undefined, true);
  return { ...f, env, keys, engine, send, calls: () => calls };
}
test("START requires an actual scheduler check-in and never claims an unstarted worker", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.engine.start("alice"),
      (e) => e.code === "AI_SCHEDULER_NOT_READY",
    );
    assert.equal((await f.engine.status("alice")).state, "stopped");
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});

for (const [label, patch] of [
  ["Algo Trading disabled", { tradeAllowed: false }],
])
  test(`unified START cannot authorize execution with ${label}`, async () => {
    const f = await setup({ executionPatch: patch });
    try {
      await f.engine.heartbeat();
      await assert.rejects(f.engine.start("alice"));
      assert.equal(f.calls(), 0);
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_trade_policy")).length,
        0,
      );
    } finally {
      await f.db.close();
    }
  });

for (const [label, patch] of [
  ["broker costs unknown", { costsVerified: false }],
  ["loss streak unknown", { consecutiveLossesVerified: false }],
  ["three consecutive losses", { consecutiveLosses: 3 }],
])
  test(`unified analysis cannot submit orders with ${label}`, async () => {
    const f = await setup({ executionPatch: patch });
    try {
      await f.engine.heartbeat();
      await f.engine.start("alice");
      assert.equal(
        (await tradingService(f.db, { now: f.now }).status("alice")).enabled,
        false,
      );
      await f.engine.cycle(f.id);
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_trade_commands")).length,
        0,
      );
    } finally {
      await f.db.close();
    }
  });

test("failed real-provider verification cannot create a unified permission or paid analysis cycle", async () => {
  const f = await setup({
    credentials: {
      status: async () => ({
        configured: true,
        revision: "billing-fixture",
        connection: { connected: false },
      }),
      test: async () => ({
        connected: false,
        error: "Fixture credits unavailable",
        errorCode: "AI_BILLING_REQUIRED",
      }),
      environment: async () => {
        throw Error("No analysis key may be resolved");
      },
    },
  });
  try {
    await f.engine.heartbeat();
    await assert.rejects(
      f.engine.start("alice"),
      (e) => e.code === "AI_BILLING_REQUIRED",
    );
    assert.equal((await f.engine.status("alice")).state, "suspended");
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_policy")).length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_commands")).length,
      0,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});
test("queue scheduler liveness is scoped to its connection and execution requires the exact active run", async () => {
  const f = await setup();
  const otherConnection = "01234567-89ab-cdef-0123-456789abcdef";
  const oldRun = "abcdef01-2345-6789-abcd-ef0123456789";
  const active = () =>
    f.db.transaction(
      async (tx) =>
        (await tradeContext(tx, f.id, f.now())).analysisEngineActive,
    );
  try {
    await f.engine.heartbeat("queue", `queue:${otherConnection}:probe`);
    assert.equal((await f.engine.status("alice")).scheduler.configured, false);
    await assert.rejects(
      f.engine.start("alice"),
      (e) => e.code === "AI_SCHEDULER_NOT_READY",
    );
    await f.engine.heartbeat("queue", `queue:${f.id}:probe`);
    assert.equal((await f.engine.start("alice")).state, "scheduled");
    assert.equal(
      await active(),
      false,
      "an infrastructure probe cannot authorize orders",
    );
    const [row] = await f.db.query(
      "SELECT run_id FROM rocket_analysis_engine WHERE connection_id=?",
      [f.id],
    );
    await f.engine.heartbeat("queue", `queue:${otherConnection}:${row.run_id}`);
    await f.engine.heartbeat("queue", `queue:${f.id}:${oldRun}`);
    assert.equal(await active(), false);
    await f.engine.heartbeat("queue", `queue:${f.id}:${row.run_id}`);
    assert.equal(await active(), true);
    f.advance(150001);
    await f.engine.heartbeat("queue", `queue:${f.id}:probe`);
    assert.equal((await f.engine.status("alice")).scheduler.configured, true);
    assert.equal(
      await active(),
      false,
      "a fresh probe cannot refresh a stalled run",
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});
test("queue callbacks cannot claim a newer run after Stop and explicit restart", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat("queue", `queue:${f.id}:probe`);
    await f.engine.start("alice");
    const [old] = await f.db.query(
      "SELECT run_id FROM rocket_analysis_engine WHERE connection_id=?",
      [f.id],
    );
    await f.engine.stop("alice");
    await f.engine.start("alice");
    const [current] = await f.db.query(
      "SELECT run_id FROM rocket_analysis_engine WHERE connection_id=?",
      [f.id],
    );
    assert.notEqual(current.run_id, old.run_id);
    assert.equal((await f.engine.cycle(f.id, old.run_id)).state, "idle");
    assert.equal(f.calls(), 0);
    assert.equal((await f.engine.status("alice")).state, "scheduled");
    await f.engine.heartbeat("queue", `queue:${f.id}:${current.run_id}`);
    assert.equal(
      (await f.engine.cycle(f.id, current.run_id)).state,
      "scheduled",
    );
    assert.equal(f.calls(), 1);
  } finally {
    await f.db.close();
  }
});
test("queue scheduler heartbeats reject unscoped identifiers", async () => {
  const f = await setup();
  try {
    for (const id of ["primary", `queue:${f.id}`, `queue:${f.id}:anything`])
      await assert.rejects(
        f.engine.heartbeat("queue", id),
        (e) => e.status === 400,
      );
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_engine_scheduler")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
for (const type of ["demo", "live"])
  test(`START on ${type} binds the unified account session; a WAIT assessment never creates a broker command`, async () => {
    const f = await setup({ type });
    try {
      await f.engine.heartbeat();
      const started = await f.engine.start("alice");
      assert.equal(started.state, "scheduled");
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_trade_policy")).length,
        1,
      );
      assert.equal(started.executionAuthorized, true);
      assert.equal((await f.engine.cycle(f.id)).state, "scheduled");
      assert.equal(f.calls(), 1);
      const [a] = await f.db.query(
        "SELECT * FROM rocket_analyses WHERE status='completed'",
      );
      assert.equal(JSON.parse(a.result).decision, "WAIT");
      assert.equal(JSON.parse(a.result).engineVersion, ENGINE_VERSION);
      const state = await f.engine.status("alice");
      assert.equal(state.usage.inputTokens, 100);
      assert.equal(state.usage.outputTokens, 50);
      assert.ok(state.usage.estimatedUsd > 0);
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_trade_commands")).length,
        0,
      );
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_engine_validation")).length,
        0,
      );
      await f.engine.cycle(f.id);
      assert.equal(f.calls(), 1, "unchanged/not-due work cannot spend again");
      await f.engine.stop("alice");
      assert.equal((await f.engine.status("alice")).state, "stopped");
    } finally {
      await f.db.close();
    }
  });
test("a later STOP cannot be overwritten by an earlier START awaiting OpenAI verification", async () => {
  const entered = deferred(),
    release = deferred();
  const keys = {
    status: async () => ({
      configured: true,
      revision: "fixture-r1",
      connection: { connected: false },
    }),
    test: async () => {
      entered.resolve();
      await release.promise;
      return { connected: true };
    },
    environment: async () => ({}),
  };
  const f = await setup({ credentials: keys });
  try {
    await f.engine.heartbeat();
    const pending = f.engine.start("alice");
    await entered.promise;
    await f.engine.stop("alice");
    release.resolve();
    await assert.rejects(pending, (e) => e.code === "AI_START_CANCELLED");
    assert.equal((await f.engine.status("alice")).state, "stopped");
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});
test("STOP while resolving a claimed job's key prevents a new provider dispatch", async () => {
  const entered = deferred(),
    release = deferred();
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    f.keys.environment = async () => {
      entered.resolve();
      await release.promise;
      return f.env;
    };
    const pending = f.engine.cycle(f.id);
    await entered.promise;
    await f.engine.stop("alice");
    release.resolve();
    await pending;
    assert.equal(f.calls(), 0);
    assert.equal((await f.engine.status("alice")).state, "stopped");
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_commands")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("STOP discards an already-dispatched response, persists stopped state and records its verified usage", async () => {
  const entered = deferred(),
    release = deferred();
  const f = await setup({
    provider: async () => {
      entered.resolve();
      await release.promise;
      return response();
    },
  });
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    const pending = f.engine.cycle(f.id);
    await entered.promise;
    await f.engine.stop("alice");
    release.resolve();
    await pending;
    const state = await f.engine.status("alice");
    assert.equal(state.state, "stopped");
    assert.equal(state.usage.inputTokens, 100);
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM rocket_analyses WHERE status='completed'",
        )
      ).length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_commands")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("provider billing failure suspends persistent engine and revokes new work without retry", async () => {
  const f = await setup({
    provider: async () => {
      throw new ApiError(
        503,
        "Fixture billing exhausted",
        "AI_BILLING_REQUIRED",
      );
    },
  });
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    await f.engine.cycle(f.id);
    assert.equal((await f.engine.status("alice")).state, "suspended");
    assert.equal(f.calls(), 1);
    await f.engine.cycle(f.id);
    assert.equal(f.calls(), 1);
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_policy")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("stale EA heartbeat waits without paid requests or new submissions", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    f.advance(31001);
    await f.engine.cycle(f.id);
    assert.equal((await f.engine.status("alice")).state, "scheduled");
    assert.match(
      (await f.engine.status("alice")).reason,
      /fresh authenticated broker data/,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});
test("same authorized terminal session reconnect resumes monitoring with no duplicate order", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    await f.send("abcdef0123456789abcdef01", true);
    assert.equal((await f.engine.status("alice")).state, "scheduled");
    assert.equal(f.calls(), 0);
    assert.equal(
      (await f.db.query("SELECT id FROM rocket_trade_commands")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("a restarted worker resumes scheduled work from the database without a browser", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    const restarted = engineService(f.db, {
      now: f.now,
      env: f.env,
      credentials: f.keys,
      provider: async () => response(),
    });
    await restarted.heartbeat("worker", "new-process");
    await restarted.drain();
    assert.equal((await restarted.status("alice")).state, "scheduled");
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM rocket_analyses WHERE status='completed'",
        )
      ).length,
      1,
    );
  } finally {
    await f.db.close();
  }
});
test("interrupted in-flight lease is never retried after worker restart", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    await f.db.query(
      "UPDATE rocket_analysis_engine SET state='running',lease_until=? WHERE connection_id=?",
      [f.now() - 1, f.id],
    );
    await f.engine.cycle(f.id);
    assert.equal((await f.engine.status("alice")).state, "stopped");
    assert.match((await f.engine.status("alice")).reason, /interrupted/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});
test("offline worker is reported suspended and cannot claim to be running indefinitely", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    f.advance(150001);
    assert.equal((await f.engine.status("alice")).scheduler.configured, false);
    assert.equal((await f.engine.status("alice")).state, "suspended");
  } finally {
    await f.db.close();
  }
});

for (const model of ["gpt-6.1-sol", "gpt-5-mini"])
  test(`the production worker reuses one verified ${model} assessment for unified authorized Demo commands`, async () => {
    const previousModel = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = model;
    const f = await setup({
      executionPatch: { tradeAllowed: true, newsVerified: true },
      provider: async () => {
        const r = response();
        r.model = model;
        r.output[0].content[0].text = JSON.stringify({
          ...assessment,
          decision: "BUY",
          confidence: 0.95,
          strategy: "trend",
          entryPrice: 2100.2,
          stopLoss: 2095.2,
          takeProfit: 2110.2,
          proposedLots: 0.1,
          entryAction: "OPEN",
        });
        return r;
      },
    });
    try {
      f.env.OPENAI_MODEL = model;
      await f.engine.heartbeat();
      await f.engine.start("alice");
      const trade = tradingService(f.db, { now: f.now });
      assert.equal((await trade.status("alice")).permissionActive, true);
      await f.engine.cycle(f.id);
      const rows = await f.db.query(
        "SELECT payload,status FROM rocket_trade_commands",
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "queued");
      const order = JSON.parse(rows[0].payload);
      assert.equal(order.source, "ai");
      assert.equal(order.kind, "OPEN");
      assert.ok(order.riskPercent <= 0.25);
      assert.ok(order.volume <= 0.1);
      assert.ok(order.analysisId);
      assert.equal(
        f.calls(),
        1,
        "execution consumes the persisted assessment, never a second provider request",
      );
      await f.engine.stop("alice");
      assert.equal(
        (await f.db.query("SELECT status FROM rocket_trade_commands"))[0]
          .status,
        "cancelled",
      );
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_engine_validation")).length,
        0,
      );
    } finally {
      if (previousModel === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = previousModel;
      await f.db.close();
    }
  });
test("server secret rotation rejects an in-flight analysis without exposing its internal revision", async () => {
  const previous = Object.fromEntries(
    ["OPENAI_API_KEY", "OPENAI_MODEL", "ROCKET_OPENAI_SERVER_MANAGED"].map(
      (k) => [k, process.env[k]],
    ),
  );
  Object.assign(process.env, {
    OPENAI_API_KEY: "sk-fixture-server-key-one",
    OPENAI_MODEL: "gpt-6.1-sol",
    ROCKET_OPENAI_SERVER_MANAGED: "1",
  });
  const f = await setup();
  const entered = deferred(),
    release = deferred();
  const engine = engineService(f.db, {
    now: f.now,
    provider: async (payload) => {
      const r = response();
      r.output[0].role = "assistant";
      if (!payload.text?.format) r.output[0].content[0].text = "ROCKET1000_OK";
      else {
        entered.resolve();
        await release.promise;
      }
      return r;
    },
  });
  try {
    // setup's seed is telemetry only; the actual credential resolver and
    // metered provider wrapper below are used, with injected transport output.
    await engine.heartbeat();
    await engine.start("alice");
    const pending = engine.cycle(f.id);
    await entered.promise;
    process.env.OPENAI_API_KEY = "sk-fixture-server-key-two";
    assert.equal(
      (await tradingService(f.db, { now: f.now }).status("alice"))
        .permissionActive,
      false,
    );
    release.resolve();
    await pending;
    assert.equal((await engine.status("alice")).state, "suspended");
    const analyses = await f.db.query("SELECT status FROM rocket_analyses");
    assert.ok(analyses.every((r) => r.status !== "completed"));
    const visible = JSON.stringify(await engine.status("alice"));
    assert.ok(!visible.includes("sk-fixture-server-key"));
    assert.ok(!visible.includes("environment:"));
  } finally {
    release.resolve();
    await f.db.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("an old provider failure cannot suspend a newer explicitly restarted run", async () => {
  const entered = deferred(),
    release = deferred();
  const f = await setup({
    provider: async () => {
      entered.resolve();
      await release.promise;
      throw new ApiError(503, "Old fixture failure", "AI_TIMEOUT");
    },
  });
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    const pending = f.engine.cycle(f.id);
    await entered.promise;
    await f.engine.stop("alice");
    await f.engine.start("alice");
    release.resolve();
    await pending;
    assert.equal((await f.engine.status("alice")).state, "scheduled");
    assert.equal(f.calls(), 1);
  } finally {
    await f.db.close();
  }
});

test("STOP best-effort aborts an already-dispatched provider request through persisted state", async () => {
  const entered = deferred();
  let aborted = false;
  const f = await setup({
    provider: async (_payload, options) => {
      entered.resolve();
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new ApiError(503, "Fixture request aborted", "AI_TIMEOUT"));
          },
          { once: true },
        ),
      );
    },
  });
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    const pending = f.engine.cycle(f.id);
    await entered.promise;
    await f.engine.stop("alice");
    await pending;
    assert.equal(aborted, true);
    assert.equal((await f.engine.status("alice")).state, "stopped");
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_commands")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
for (const action of ["save", "remove"])
  test(`OpenAI ${action} atomically stops the new persistent engine through the production hook`, async () => {
    const f = await setup();
    try {
      await f.engine.heartbeat();
      await f.engine.start("alice");
      const keys = openaiCredentialService(f.db, {
        now: f.now,
        env: {
          ...f.env,
          ROCKET_OPENAI_SERVER_MANAGED: "0",
          ROCKET_OPENAI_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
        },
        onChange: credentialChanged,
      });
      if (action === "save")
        await keys.save("alice", {
          key: "sk-fixture-replacement-not-a-real-key",
        });
      else await keys.remove("alice");
      assert.equal((await f.engine.status("alice")).state, "stopped");
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_trade_policy")).length,
        0,
      );
    } finally {
      await f.db.close();
    }
  });
