import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrateConnections } from "../server/database.mjs";
import {
  openaiCredentialService,
  openaiCredentialSchema,
  assertOpenaiHttps,
} from "../server/openai-credentials.mjs";

// Isolated fake credentials and Responses transport. No real provider or broker.
const KEY = "sk-project-credential-fixture-not-a-real-key";
const REPLACEMENT = "sk-project-replacement-fixture-not-a-real-key";
const NOW = 1800000000000;
async function fixture(options = {}) {
  const db = openDatabase({ filename: ":memory:" });
  await migrateConnections(db);
  for (const sql of openaiCredentialSchema) await db.query(sql);
  for (const uid of ["alice", "bob"])
    await db.query(
      "INSERT INTO rocket_workspaces(id,created_at,expires_at) VALUES(?,?,?)",
      [uid, NOW, NOW + 1000000],
    );
  const env = {
    ROCKET_OPENAI_SERVER_MANAGED: "0",
    ROCKET_OPENAI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    OPENAI_MODEL: "gpt-6.1-sol",
    ...options.env,
  };
  const service = openaiCredentialService(db, {
    ...options,
    now: () => NOW,
    env,
  });
  return { db, env, service };
}

test("saving encrypts a workspace key with random GCM nonce and returns metadata only", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.status("alice")).configured, false);
    const saved = await f.service.save("alice", { key: KEY });
    assert.equal(saved.configured, true);
    assert.equal(saved.stored, true);
    assert.equal(saved.connection.connected, false);
    assert.equal(saved.connection.state, "configured");
    assert.equal(saved.source, "saved");
    assert.ok(!JSON.stringify(saved).includes(KEY));
    assert.ok(!JSON.stringify(saved).includes("ciphertext"));
    assert.ok(!JSON.stringify(saved).includes("fingerprint"));
    const [row] = await f.db.query(
      "SELECT * FROM rocket_openai_credentials WHERE user_id=?",
      ["alice"],
    );
    assert.ok(!JSON.stringify(row).includes(KEY));
    assert.equal(Buffer.from(row.nonce, "base64").length, 12);
    assert.equal(Buffer.from(row.tag, "base64").length, 16);
    assert.equal((await f.service.environment("alice")).OPENAI_API_KEY, KEY);
    assert.equal((await f.service.status("bob")).configured, false);
    await f.service.save("alice", { key: KEY });
    const [second] = await f.db.query(
      "SELECT * FROM rocket_openai_credentials WHERE user_id=?",
      ["alice"],
    );
    assert.notEqual(second.nonce, row.nonce);
    assert.notEqual(second.revision, row.revision);
  } finally {
    await f.db.close();
  }
});

test("rotation and removal revoke future orders and analysis atomically without closing positions", async () => {
  let callbackCount = 0;
  const f = await fixture({
    onChange: async (_uid, tx) => {
      callbackCount++;
      await tx.query(
        "UPDATE rocket_direct_connections SET label='credential changed'",
      );
    },
  });
  try {
    await f.db.query(
      "INSERT INTO rocket_direct_connections(id,user_id,label,stopped,created_at) VALUES('c','alice','fixture',0,?)",
      [NOW],
    );
    await f.db.query(
      "INSERT INTO rocket_trade_policy(connection_id,installation_id,session_id,expires_at) VALUES('c','i','s',?)",
      [NOW + 60000],
    );
    await f.db.query(
      "INSERT INTO rocket_automation(connection_id,run_id,installation_id,session_id,state) VALUES('c','r','i','s','running')",
    );
    await f.db.query(
      "INSERT INTO rocket_analyses(id,connection_id,installation_id,status,created_at) VALUES('a','c','i','pending',?)",
      [NOW],
    );
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES('o','p','c','i','s','{}','queued',?,?)",
      [NOW, NOW + 60000],
    );
    await f.service.save("alice", { key: KEY });
    await f.service.save("alice", { key: REPLACEMENT });
    assert.equal(
      (await f.service.environment("alice")).OPENAI_API_KEY,
      REPLACEMENT,
    );
    assert.equal(callbackCount, 2);
    assert.equal(
      (await f.db.query("SELECT stopped FROM rocket_direct_connections"))[0]
        .stopped,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT state FROM rocket_automation"))[0].state,
      "stopped",
    );
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_policy")).length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT status FROM rocket_trade_commands"))[0].status,
      "cancelled",
    );
    assert.equal(
      (await f.db.query("SELECT status FROM rocket_analyses"))[0].status,
      "cancelled",
    );
    const removed = await f.service.remove("alice");
    assert.equal(removed.configured, false);
    assert.equal(removed.connection.connected, false);
    const [row] = await f.db.query("SELECT * FROM rocket_openai_credentials");
    for (const name of ["ciphertext", "nonce", "tag"])
      assert.equal(row[name], null);
  } finally {
    await f.db.close();
  }
});

test("a failed revocation hook rolls back the entire key replacement", async () => {
  const f = await fixture();
  try {
    await f.service.save("alice", { key: KEY });
    const failing = openaiCredentialService(f.db, {
      env: f.env,
      now: () => NOW,
      onChange: () => {
        throw Error("fixture transaction rollback");
      },
    });
    await assert.rejects(failing.save("alice", { key: REPLACEMENT }));
    assert.equal((await f.service.environment("alice")).OPENAI_API_KEY, KEY);
  } finally {
    await f.db.close();
  }
});

test("GCM rejects ciphertext tampering, cross-workspace copying and a different encryption secret", async () => {
  const f = await fixture();
  try {
    await f.service.save("alice", { key: KEY });
    await f.db.query(
      "INSERT INTO rocket_openai_credentials SELECT 'bob',ciphertext,nonce,tag,version,model,revision,updated_at,removed_at FROM rocket_openai_credentials WHERE user_id='alice'",
    );
    await assert.rejects(f.service.environment("bob"), {
      code: "OPENAI_ENCRYPTION_UNAVAILABLE",
    });
    const other = openaiCredentialService(f.db, {
      env: {
        ...f.env,
        ROCKET_OPENAI_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
      },
      now: () => NOW,
    });
    await assert.rejects(other.environment("alice"), {
      code: "OPENAI_ENCRYPTION_UNAVAILABLE",
    });
    assert.equal((await other.status("alice")).connection.connected, false);
    await f.db.query(
      "UPDATE rocket_openai_credentials SET tag=? WHERE user_id='alice'",
      [Buffer.alloc(16).toString("base64")],
    );
    await assert.rejects(f.service.environment("alice"), {
      code: "OPENAI_ENCRYPTION_UNAVAILABLE",
    });
  } finally {
    await f.db.close();
  }
});

test("Remove cannot silently fall back to an environment key or a Gateway account", async () => {
  const f = await fixture({
    env: {
      OPENAI_API_KEY: KEY,
      AI_GATEWAY_API_KEY: "fixture-gateway",
      VERCEL: "1",
    },
  });
  try {
    assert.equal((await f.service.status("alice")).source, "environment");
    await f.service.remove("alice");
    const env = await f.service.environment("alice");
    assert.equal(env.OPENAI_API_KEY, "");
    assert.equal(env.AI_GATEWAY_API_KEY, "");
    assert.equal(env.ROCKET_OPENAI_DIRECT_ONLY, "1");
    await assert.rejects(f.service.test("alice"), { code: "AI_AUTH_REQUIRED" });
  } finally {
    await f.db.close();
  }
});

test("key validation, missing encryption and expired workspace fail without leaking input", async () => {
  const f = await fixture();
  try {
    for (const key of [
      "",
      "plain-text-not-a-key",
      KEY + "\n",
      KEY + " injected",
      KEY.repeat(20),
    ])
      await assert.rejects(
        f.service.save("alice", { key }),
        (e) => e.code === "OPENAI_KEY_INVALID" && !e.message.includes(KEY),
      );
    await assert.rejects(
      f.service.save("alice", { key: KEY, unexpected: KEY }),
      { code: "OPENAI_KEY_INVALID" },
    );
    await assert.rejects(f.service.save("missing", { key: KEY }), {
      code: "BROWSER_SESSION_REQUIRED",
    });
    await f.db.query(
      "UPDATE rocket_workspaces SET expires_at=? WHERE id='alice'",
      [NOW],
    );
    await assert.rejects(f.service.save("alice", { key: KEY }), {
      code: "BROWSER_SESSION_REQUIRED",
    });
    const noSecret = openaiCredentialService(f.db, {
      now: () => NOW,
      env: { ROCKET_OPENAI_SERVER_MANAGED: "0" },
    });
    await assert.rejects(noSecret.save("bob", { key: KEY }), {
      code: "OPENAI_ENCRYPTION_UNAVAILABLE",
    });
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_openai_credentials")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});

test("HTTPS is mandatory for credential changes even on localhost", () => {
  assert.throws(
    () => assertOpenaiHttps(new Request("http://localhost/api/mt5/openai")),
    { code: "OPENAI_HTTPS_REQUIRED" },
  );
  assert.throws(
    () =>
      assertOpenaiHttps(
        new Request("http://example.test/api/mt5/openai", {
          headers: { "x-forwarded-proto": "https" },
        }),
      ),
    { code: "OPENAI_HTTPS_REQUIRED" },
  );
  assert.doesNotThrow(() =>
    assertOpenaiHttps(new Request("https://rocket.example/api/mt5/openai")),
  );
});

test("only a completed real-format Responses probe marks the saved key Connected", async () => {
  let calls = 0;
  const f = await fixture({
    responder: async (payload, options) => {
      calls++;
      assert.equal(options.env.OPENAI_API_KEY, KEY);
      assert.equal(options.env.ROCKET_OPENAI_DIRECT_ONLY, "1");
      assert.equal(payload.model, "gpt-6-luna");
      assert.equal(payload.max_output_tokens, 256);
      assert.ok(!JSON.stringify(payload).includes(KEY));
      assert.ok(!JSON.stringify(payload).includes("balance"));
      return {
        status: "completed",
        model: "gpt-6-luna",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ROCKET1000_OK" }],
          },
        ],
      };
    },
  });
  try {
    await f.service.save("alice", { key: KEY, model: "gpt-6-luna" });
    assert.equal((await f.service.status("alice")).connection.connected, false);
    const result = await f.service.test("alice");
    assert.equal(result.connected, true);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.equal((await f.service.status("bob")).connection.connected, false);
  } finally {
    await f.db.close();
  }
});
