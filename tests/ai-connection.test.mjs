import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrateConnections } from "../server/database.mjs";
import { aiConnectionService } from "../server/ai-connection.mjs";
import { ApiError } from "../server/errors.mjs";
import { MODEL } from "../server/ai-provider.mjs";

// All credentials and model responses in this file are isolated test fixtures.
// No provider, terminal, broker order or real account is contacted.
const NOW = 1800000000000;
function success(overrides = {}) {
  return {
    id: "resp_connection_fixture_only",
    status: "completed",
    model: MODEL,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ROCKET1000_OK" }],
      },
    ],
    ...overrides,
  };
}
async function fixture(options = {}) {
  const db = openDatabase({ filename: ":memory:" });
  await migrateConnections(db);
  for (const uid of ["alice", "bob"])
    await db.query(
      "INSERT INTO rocket_workspaces(id,created_at,expires_at) VALUES(?,?,?)",
      [uid, NOW, NOW + 180 * 86400000],
    );
  const env = { OPENAI_API_KEY: "fixture-server-private-key" };
  let clock = NOW;
  let calls = 0;
  let lastPayload;
  const now = () => clock;
  const responder = async (payload, opts) => {
    calls++;
    lastPayload = structuredClone(payload);
    return options.responder ? options.responder(payload, opts) : success();
  };
  const service = aiConnectionService(db, { now, env, responder });
  return {
    db,
    env,
    now,
    service,
    calls: () => calls,
    payload: () => lastPayload,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("AI connection GET is private, free, unconfigured or configured without implying success", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.service.status("alice"), {
      configured: true,
      provider: "OpenAI",
      model: MODEL,
      state: "configured",
      connected: false,
      checkedAt: null,
      lastSuccessAt: null,
      errorCode: null,
      error: null,
    });
    delete f.env.OPENAI_API_KEY;
    assert.equal((await f.service.status("alice")).state, "unconfigured");
    await assert.rejects(f.service.test("alice"), { code: "AI_AUTH_REQUIRED" });
    assert.equal(f.calls(), 0);
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_ai_connection_checks")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});

test("a genuine successful diagnostic shows Connected only for this workspace and credential", async () => {
  const f = await fixture();
  try {
    const result = await f.service.test("alice");
    assert.equal(result.state, "connected");
    assert.equal(result.connected, true);
    assert.equal(result.checkedAt, NOW);
    assert.equal(result.lastSuccessAt, NOW);
    assert.equal(f.calls(), 1);
    assert.equal((await f.service.status("bob")).state, "configured");
    assert.equal(f.calls(), 1);
    assert.equal(JSON.stringify(result).includes(f.env.OPENAI_API_KEY), false);
    assert.equal(Object.hasOwn(result, "config_hash"), false);
    const [stored] = await f.db.query(
      "SELECT * FROM rocket_ai_connection_checks",
    );
    assert.match(stored.config_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(stored).includes(f.env.OPENAI_API_KEY), false);
    f.env.OPENAI_API_KEY = "fixture-rotated-private-key";
    const rotated = await f.service.status("alice");
    assert.equal(rotated.connected, false);
    assert.equal(rotated.lastSuccessAt, null);
    assert.equal(rotated.state, "configured");
  } finally {
    await f.db.close();
  }
});

test("diagnostic prompt is fixed, bounded and contains no MT5 data or trading tools", async () => {
  const f = await fixture();
  try {
    await f.service.test("alice");
    assert.deepEqual(f.payload(), {
      model: MODEL,
      instructions:
        "This is a connection diagnostic. Reply with exactly ROCKET1000_OK and nothing else.",
      input: "ROCKET1000 connection test. Return ROCKET1000_OK.",
      reasoning: { effort: "low" },
      max_output_tokens: 256,
      store: false,
    });
    for (const table of [
      "rocket_direct_connections",
      "rocket_trade_commands",
      "rocket_trade_policy",
      "rocket_live_consents",
      "rocket_live_approvals",
      "rocket_analyses",
      "rocket_ai_health",
      "rocket_engine_validation",
    ])
      assert.equal(
        (await f.db.query(`SELECT * FROM ${table}`)).length,
        0,
        table,
      );
  } finally {
    await f.db.close();
  }
});

for (const model of [`openai/${MODEL}`, `${MODEL}-2026-10-14`]) {
  test(`connection accepts the configured model family: ${model}`, async () => {
    const f = await fixture({ responder: async () => success({ model }) });
    try {
      assert.equal((await f.service.test("alice")).connected, true);
    } finally {
      await f.db.close();
    }
  });
}

for (const [label, response] of [
  ["incomplete", success({ status: "incomplete" })],
  ["wrong model", success({ model: "another-model" })],
  ["no output", success({ output: [] })],
  [
    "output_text shortcut without actual output",
    success({ output: undefined, output_text: "ROCKET1000_OK" }),
  ],
  [
    "wrong text",
    success({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "BUY NOW" }],
        },
      ],
    }),
  ],
  [
    "refusal",
    success({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "No" }],
        },
      ],
    }),
  ],
]) {
  test(`invalid connection response fails closed: ${label}`, async () => {
    const f = await fixture({ responder: async () => response });
    try {
      const result = await f.service.test("alice");
      assert.equal(result.connected, false);
      assert.equal(result.state, "error");
      assert.equal(result.errorCode, "AI_INVALID_RESPONSE");
      assert.equal(result.lastSuccessAt, null);
    } finally {
      await f.db.close();
    }
  });
}

test("provider failures are sanitized before storage and browser responses", async () => {
  const f = await fixture({
    responder: async () => {
      throw new ApiError(
        401,
        "fixture-server-private-key secret error body",
        "AI_AUTH_REQUIRED",
      );
    },
  });
  try {
    const result = await f.service.test("alice");
    assert.equal(result.errorCode, "AI_AUTH_REQUIRED");
    assert.equal(result.connected, false);
    assert.equal(
      JSON.stringify(result).includes("fixture-server-private-key"),
      false,
    );
    assert.equal(
      JSON.stringify(
        await f.db.query("SELECT * FROM rocket_ai_connection_checks"),
      ).includes("secret error body"),
      false,
    );
  } finally {
    await f.db.close();
  }
});

test("unexpected exceptions never expose raw messages or credentials", async () => {
  const f = await fixture({
    responder: async () => {
      throw new Error("fixture-server-private-key network body");
    },
  });
  try {
    const result = await f.service.test("alice");
    assert.equal(result.errorCode, "AI_UNAVAILABLE");
    assert.doesNotMatch(
      JSON.stringify(result),
      /fixture-server-private-key|network body/,
    );
  } finally {
    await f.db.close();
  }
});

test("workspace rate limit persists across service instances and key rotation", async () => {
  const f = await fixture();
  try {
    await f.service.test("alice");
    f.env.OPENAI_API_KEY = "fixture-other-key";
    const other = aiConnectionService(f.db, {
      env: f.env,
      now: f.now,
      responder: async () =>
        assert.fail("rate-limited request must not reach provider"),
    });
    f.advance(59999);
    await assert.rejects(other.test("alice"), {
      code: "AI_TEST_RATE_LIMITED",
      status: 429,
    });
    f.advance(1);
    assert.equal((await f.service.test("alice")).connected, true);
    assert.equal(f.calls(), 2);
  } finally {
    await f.db.close();
  }
});

test("atomic global lease prevents concurrent diagnostic spend and shows Testing", async () => {
  let finish;
  let entered;
  const start = new Promise((resolve) => {
    entered = resolve;
  });
  const response = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture({
    responder: async () => {
      entered();
      return response;
    },
  });
  try {
    const first = f.service.test("alice");
    await start;
    assert.equal((await f.service.status("alice")).state, "testing");
    await assert.rejects(f.service.test("alice"), {
      code: "AI_TEST_RATE_LIMITED",
    });
    await assert.rejects(f.service.test("bob"), { code: "AI_TEST_BUSY" });
    assert.equal(f.calls(), 1);
    finish(success());
    assert.equal((await first).connected, true);
    assert.equal((await f.service.test("bob")).connected, true);
  } finally {
    finish?.(success());
    await f.db.close();
  }
});

test("global hourly and daily diagnostic budgets are persistent and bounded", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) {
      await f.service.test("alice");
      f.advance(60000);
    }
    await assert.rejects(f.service.test("alice"), {
      code: "AI_TEST_BUDGET_LIMITED",
    });
    assert.equal(f.calls(), 10);
    f.advance(3600000);
    await f.service.test("alice");
    await f.db.query("UPDATE rocket_ai_connection_budget SET day_hits=100");
    f.advance(60000);
    await assert.rejects(f.service.test("alice"), {
      code: "AI_TEST_BUDGET_LIMITED",
    });
    f.advance(86400000);
    assert.equal((await f.service.test("alice")).connected, true);
  } finally {
    await f.db.close();
  }
});

test("expired success is labelled configured; interrupted test never remains Connected", async () => {
  const f = await fixture();
  try {
    await f.service.test("alice");
    f.advance(15 * 60000);
    const expired = await f.service.status("alice");
    assert.equal(expired.connected, false);
    assert.equal(expired.state, "configured");
    assert.equal(expired.lastSuccessAt, NOW);
    await f.db.query(
      "UPDATE rocket_ai_connection_checks SET state='testing',lease_until=?,checked_at=? WHERE user_id=?",
      [f.now() + 60000, f.now(), "alice"],
    );
    assert.equal((await f.service.status("alice")).state, "testing");
    f.advance(60000);
    assert.equal(
      (await f.service.status("alice")).errorCode,
      "AI_TEST_INTERRUPTED",
    );
    assert.equal(f.calls(), 1);
  } finally {
    await f.db.close();
  }
});

test("a credential change during the request cannot create Connected for the new key", async () => {
  let f;
  f = await fixture({
    responder: async () => {
      f.env.OPENAI_API_KEY = "fixture-rotated-mid-request";
      return success();
    },
  });
  try {
    const result = await f.service.test("alice");
    assert.equal(result.connected, false);
    assert.equal(result.state, "configured");
    assert.equal(result.lastSuccessAt, null);
    const [stored] = await f.db.query(
      "SELECT state,error_code FROM rocket_ai_connection_checks WHERE user_id=?",
      ["alice"],
    );
    assert.deepEqual(stored, {
      state: "error",
      error_code: "AI_CONFIGURATION_CHANGED",
    });
  } finally {
    await f.db.close();
  }
});

test("unknown or expired workspaces cannot make paid diagnostic requests", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.test("unknown"), {
      code: "BROWSER_SESSION_REQUIRED",
    });
    await f.db.query("UPDATE rocket_workspaces SET expires_at=? WHERE id=?", [
      f.now(),
      "alice",
    ]);
    await assert.rejects(f.service.test("alice"), {
      code: "BROWSER_SESSION_REQUIRED",
    });
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});

test("an expired response cannot mark the provider Connected or clear a newer request lease", async () => {
  const resolvers = [];
  const starts = [];
  const f = await fixture({
    responder: async () => {
      starts.shift()?.();
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  try {
    let entered = new Promise((resolve) => starts.push(resolve));
    const first = f.service.test("alice");
    await entered;
    f.advance(60000);
    entered = new Promise((resolve) => starts.push(resolve));
    const second = f.service.test("alice");
    await entered;
    resolvers[0](success());
    assert.equal((await first).state, "testing");
    const [budget] = await f.db.query(
      "SELECT lease_id,lease_until FROM rocket_ai_connection_budget",
    );
    assert.ok(budget.lease_id);
    assert.equal(Number(budget.lease_until), f.now() + 60000);
    resolvers[1](success());
    assert.equal((await second).connected, true);
    assert.equal(f.calls(), 2);
  } finally {
    for (const resolve of resolvers) resolve(success());
    await f.db.close();
  }
});
