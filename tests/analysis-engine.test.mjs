import { test } from "node:test";
import assert from "node:assert/strict";
import { engineService } from "../server/engine-service.mjs";
import { ApiError } from "../server/errors.mjs";
import { fixture, market, terminal } from "./helpers.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { tradingService } from "../server/trading.mjs";
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
  tradeAllowed: false,
  stopsVerified: true,
  newsVerified: false,
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
for (const type of ["demo", "live"])
  test(`START on ${type} analyses only: real analysis code, fixture Responses transport, no trading policy or commands`, async () => {
    const f = await setup({ type });
    try {
      await f.engine.heartbeat();
      const started = await f.engine.start("alice");
      assert.equal(started.state, "scheduled");
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_trade_policy")).length,
        0,
      );
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
test("stale EA heartbeat suspends analysis before a model request", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    f.advance(31001);
    await f.engine.cycle(f.id);
    assert.equal((await f.engine.status("alice")).state, "suspended");
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});
test("terminal session switching invalidates a persisted analysis run", async () => {
  const f = await setup();
  try {
    await f.engine.heartbeat();
    await f.engine.start("alice");
    await f.send("abcdef0123456789abcdef01");
    await f.engine.cycle(f.id);
    assert.equal((await f.engine.status("alice")).state, "suspended");
    assert.equal(f.calls(), 0);
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
  test(`the production worker reuses one verified ${model} assessment for separately authorized Demo commands`, async () => {
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
      if (model !== "gpt-6.1-sol")
        await f.db.query(
          "INSERT INTO rocket_openai_credentials(user_id,version,model,revision,updated_at) VALUES(?,?,?,?,?)",
          ["alice", 1, model, "fixture-r1", f.now()],
        );
      await f.engine.heartbeat();
      await f.engine.start("alice");
      const trade = tradingService(f.db, { now: f.now });
      await assert.rejects(
        trade.act("alice", {
          action: "start-auto",
          accountKey: (await trade.status("alice")).accountKey,
        }),
        (e) => e.code === "DEMO_AUTHORIZATION_REQUIRED",
      );
      await trade.act("alice", {
        action: "start-auto",
        accountKey: (await trade.status("alice")).accountKey,
        confirmation: "ENABLE DEMO 12345678",
      });
      await f.engine.cycle(f.id);
      const rows = await f.db.query(
        "SELECT payload,status FROM rocket_trade_commands",
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "queued");
      const order = JSON.parse(rows[0].payload);
      assert.equal(order.source, "ai");
      assert.equal(order.kind, "OPEN");
      assert.ok(order.riskPercent <= 0.5);
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
      await f.db.close();
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
