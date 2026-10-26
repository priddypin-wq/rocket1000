import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openDatabase, migrateConnections } from "../server/database.mjs";
import {
  assertOpenaiCredentialWritable,
  assertOpenaiHttps,
  openaiCredentialService,
  openaiServerManaged,
} from "../server/openai-credentials.mjs";
import { ApiError } from "../server/errors.mjs";
import { handle, jsonInput } from "../server/http.mjs";
import { usageService } from "../server/ai-usage.mjs";

// Isolated dummy credentials, database, and provider transport. No network calls.
const KEY = "sk-server-environment-fixture-not-a-real-key";
const BROWSER_KEY = "sk-browser-fixture-not-a-real-key";
const NOW = 1800000000000;
const require = createRequire(import.meta.url);

async function fixture(overrides = {}) {
  const db = openDatabase({ filename: ":memory:" });
  await migrateConnections(db);
  await db.query(
    "INSERT INTO rocket_workspaces(id,created_at,expires_at) VALUES('alice',?,?)",
    [NOW, NOW + 1000000],
  );
  const env = {
    OPENAI_API_KEY: KEY,
    OPENAI_MODEL: "gpt-5-mini",
    ...overrides,
  };
  const calls = [];
  const provider = async (payload, options) => {
    calls.push({ payload, env: options.env });
    return {
      status: "completed",
      model: payload.model,
      usage: { input_tokens: 20, output_tokens: 5 },
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ROCKET1000_OK" }],
        },
      ],
    };
  };
  const service = openaiCredentialService(db, {
    env,
    now: () => NOW,
    responder: usageService(db, { env, now: () => NOW, provider }).responder(
      "alice",
      "connection-test",
    ),
  });
  const legacy = openaiCredentialService(db, {
    env: {
      ...env,
      ROCKET_OPENAI_SERVER_MANAGED: "0",
      ROCKET_OPENAI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    now: () => NOW,
  });
  return { db, env, calls, provider, service, legacy };
}

function evaluateTs(source, filename, modules) {
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const compiledModule = { exports: {} };
  const localRequire = (name) =>
    Object.hasOwn(modules, name) ? modules[name] : require(name);
  new Function("require", "module", "exports", compiled.outputText)(
    localRequire,
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports;
}

async function route(f) {
  const source = await readFile(
    new URL("../app/api/mt5/openai/route.ts", import.meta.url),
    "utf8",
  );
  return evaluateTs(source, "route.ts", {
    "../../../../server/http.mjs": {
      dashboardRequest: (_req, fn) => handle(() => fn(null, "alice")),
      jsonInput,
    },
    "../../../../server/database.mjs": { getDatabase: () => f.db },
    "../../../../server/errors.mjs": { ApiError },
    "../../../../server/ai-usage.mjs": {
      usageService: (db) =>
        usageService(db, {
          env: f.env,
          now: () => NOW,
          provider: f.provider,
        }),
    },
    "../../../../server/engine-service.mjs": {
      credentialChanged: () => {
        throw Error("Managed credentials must never invoke browser mutation");
      },
    },
    "../../../../server/openai-credentials.mjs": {
      openaiCredentialService: (db, options = {}) =>
        openaiCredentialService(db, {
          ...options,
          env: f.env,
          now: () => NOW,
        }),
      assertOpenaiHttps,
      openaiServerManaged: () => openaiServerManaged(f.env),
      assertOpenaiCredentialWritable: () =>
        assertOpenaiCredentialWritable(f.env),
    },
  });
}

function post(body) {
  return new Request("https://rocket.example/api/mt5/openai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("server-managed credentials are the default and require an exact operator opt-in to disable", () => {
  for (const value of [undefined, "", "1", "false", "0 "])
    assert.equal(
      openaiServerManaged({ ROCKET_OPENAI_SERVER_MANAGED: value }),
      true,
    );
  assert.equal(
    openaiServerManaged({ ROCKET_OPENAI_SERVER_MANAGED: "0" }),
    false,
  );
});

test("server environment key and model take priority over saved browser credentials without an encryption secret", async () => {
  const f = await fixture({ OPENAI_API_KEY: `  ${KEY}  ` });
  try {
    await f.legacy.save("alice", {
      key: BROWSER_KEY,
      model: "gpt-6-luna",
    });
    const resolved = await f.service.environment("alice");
    assert.equal(resolved.OPENAI_API_KEY, KEY);
    assert.equal(resolved.OPENAI_MODEL, "gpt-5-mini");
    assert.equal(resolved.ROCKET_OPENAI_DIRECT_ONLY, "1");
    assert.equal(resolved.AI_GATEWAY_API_KEY, "");
    assert.equal(resolved.VERCEL_OIDC_TOKEN, "");
    const status = await f.service.status("alice");
    assert.equal(status.serverManaged, true);
    assert.equal(status.configured, true);
    assert.equal(status.stored, false);
    assert.equal(status.source, "environment");
    assert.equal(status.model, "gpt-5-mini");
    assert.equal(status.connection.connected, false);
    for (const secret of [
      KEY,
      BROWSER_KEY,
      "ciphertext",
      "nonce",
      "fingerprint",
    ])
      assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(Object.hasOwn(status, "encryptionReady"), false);
    await assert.rejects(f.service.environment("missing"), {
      code: "BROWSER_SESSION_REQUIRED",
    });
  } finally {
    await f.db.close();
  }
});

test("managed mode rejects browser saves and removals before storing or using a supplied key", async () => {
  const f = await fixture();
  try {
    for (const operation of [
      () => f.service.save("alice", { key: BROWSER_KEY }),
      () => f.service.save("alice", { key: BROWSER_KEY, model: "gpt-6-luna" }),
      () => f.service.remove("alice"),
    ])
      await assert.rejects(operation, (error) => {
        assert.equal(error.status, 423);
        assert.equal(error.code, "OPENAI_SERVER_MANAGED");
        assert.equal(error.message.includes(KEY), false);
        assert.equal(error.message.includes(BROWSER_KEY), false);
        return true;
      });
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_openai_credentials")).length,
      0,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.db.close();
  }
});

test("missing server key cannot fall back to a stored credential, Gateway, or OIDC", async () => {
  const f = await fixture({
    OPENAI_API_KEY: "",
    AI_GATEWAY_API_KEY: "fixture-gateway-secret",
    VERCEL_OIDC_TOKEN: "fixture-oidc-secret",
    VERCEL: "1",
  });
  try {
    await f.legacy.save("alice", { key: BROWSER_KEY });
    assert.equal((await f.service.status("alice")).configured, false);
    const resolved = await f.service.environment("alice");
    for (const name of [
      "OPENAI_API_KEY",
      "AI_GATEWAY_API_KEY",
      "VERCEL_OIDC_TOKEN",
    ])
      assert.equal(resolved[name], "");
    await assert.rejects(f.service.test("alice"), { code: "AI_AUTH_REQUIRED" });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.db.close();
  }
});

test("a previous Remove tombstone still disables server-managed paid requests", async () => {
  const f = await fixture();
  try {
    await f.legacy.remove("alice");
    const status = await f.service.status("alice");
    assert.equal(status.disabledByRemoval, true);
    assert.equal(status.configured, false);
    assert.equal(status.source, "none");
    assert.equal((await f.service.environment("alice")).OPENAI_API_KEY, "");
    await assert.rejects(f.service.test("alice"), { code: "AI_AUTH_REQUIRED" });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.db.close();
  }
});

test("the OpenAI route rejects credential-bearing mutations and runs only the budgeted server connection test", async () => {
  const f = await fixture();
  try {
    const endpoint = await route(f);
    for (const body of [
      { action: "save", key: BROWSER_KEY },
      { action: "remove" },
      { action: "set-key", key: BROWSER_KEY },
      { action: "test", key: BROWSER_KEY },
      { action: "test", model: "gpt-6-luna" },
      { OPENAI_API_KEY: BROWSER_KEY },
    ]) {
      const response = await endpoint.POST(post(body));
      assert.equal(response.status, 423);
      const payload = await response.json();
      assert.equal(payload.code, "OPENAI_SERVER_MANAGED");
      assert.equal(JSON.stringify(payload).includes(BROWSER_KEY), false);
      assert.equal(JSON.stringify(payload).includes(KEY), false);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_openai_credentials")).length,
      0,
    );
    const response = await endpoint.POST(post({ action: "test" }));
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.equal(metadata.connection.connected, true);
    assert.equal(metadata.model, "gpt-5-mini");
    assert.equal(JSON.stringify(metadata).includes(KEY), false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].env.OPENAI_API_KEY, KEY);
    assert.equal(f.calls[0].env.ROCKET_OPENAI_DIRECT_ONLY, "1");
    assert.equal(f.calls[0].payload.model, "gpt-5-mini");
    assert.equal(f.calls[0].payload.max_output_tokens, 256);
    assert.equal(f.calls[0].payload.store, false);
    assert.equal(JSON.stringify(f.calls[0].payload).includes(KEY), false);
    const [usage] = await f.db.query("SELECT * FROM rocket_ai_usage");
    assert.equal(usage.kind, "connection-test");
    assert.equal(usage.status, "completed");
    assert.equal(Number(usage.input_tokens), 20);
    assert.equal(Number(usage.output_tokens), 5);
    assert.equal((await endpoint.POST(post({ action: "test" }))).status, 429);
    assert.equal(f.calls.length, 1);
    const get = await endpoint.GET(
      new Request("https://rocket.example/api/mt5/openai"),
    );
    assert.equal(get.status, 200);
    assert.equal((await get.text()).includes(KEY), false);
  } finally {
    await f.db.close();
  }
});

test("a connection test that exceeds the server budget cannot contact the provider", async () => {
  const f = await fixture({ ROCKET_AI_DAILY_BUDGET_USD: "0.1" });
  try {
    await f.db.query(
      "INSERT INTO rocket_ai_usage(id,user_id,day_bucket,kind,model,status,reserved_microusd,charged_microusd,created_at) VALUES('spent','alice',?,'connection-test','gpt-5-mini','completed',0,100000,?)",
      [Math.floor(NOW / 86400000), NOW],
    );
    const result = await f.service.test("alice");
    assert.equal(result.connected, false);
    assert.equal(result.errorCode, "AI_BUDGET_REACHED");
    assert.equal(f.calls.length, 0);
  } finally {
    await f.db.close();
  }
});

test("rotating a server secret or model invalidates previous connection verification", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.test("alice")).connected, true);
    f.env.OPENAI_API_KEY = "sk-rotated-server-fixture-not-a-real-key";
    let status = await f.service.status("alice");
    assert.equal(status.configured, true);
    assert.equal(status.connection.connected, false);
    assert.equal(status.connection.state, "configured");
    f.env.OPENAI_API_KEY = KEY;
    f.env.OPENAI_MODEL = "gpt-5.4";
    status = await f.service.status("alice");
    assert.equal(status.model, "gpt-5.4");
    assert.equal(status.connection.connected, false);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.db.close();
  }
});

test("provider errors containing credentials are sanitized before route metadata and persistence", async () => {
  const f = await fixture();
  try {
    f.provider = async () => {
      throw Error(`Provider rejected ${KEY} and ${BROWSER_KEY}`);
    };
    const endpoint = await route(f);
    const response = await endpoint.POST(post({ action: "test" }));
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.equal(metadata.connection.connected, false);
    assert.equal(metadata.connection.errorCode, "AI_UNAVAILABLE");
    const records = await f.db.query(
      "SELECT * FROM rocket_ai_connection_checks",
    );
    for (const value of [metadata, records]) {
      assert.equal(JSON.stringify(value).includes(KEY), false);
      assert.equal(JSON.stringify(value).includes(BROWSER_KEY), false);
      assert.equal(JSON.stringify(value).includes("Provider rejected"), false);
    }
  } finally {
    await f.db.close();
  }
});

test("the settings panel defaults to server status and model without browser key or model inputs", async () => {
  const source = await readFile(
    new URL("../app/components/openai-connection.tsx", import.meta.url),
    "utf8",
  );
  for (const metadata of [
    null,
    { configured: true, serverManaged: true, model: "gpt-5-mini" },
    { configured: false, serverManaged: true },
    { configured: true, model: "gpt-5-mini" },
  ]) {
    let hook = 0;
    const component = evaluateTs(source, "openai-connection.tsx", {
      react: {
        ...React,
        useState: (initial) => [hook++ === 0 ? metadata : initial, () => {}],
        useEffect: () => {},
        useRef: (initial) => ({ current: initial }),
      },
      "../../lib/mt5-client": {
        mt5Api: () => {
          throw Error("Rendering must not submit requests");
        },
      },
    }).default;
    const html = renderToStaticMarkup(React.createElement(component));
    assert.match(html, /Server managed/);
    assert.match(html, /Test Connection/);
    assert.match(html, /Model:/);
    assert.doesNotMatch(
      html,
      /<input|Save API Key|Replace API Key|Remove API Key/,
    );
    assert.equal(html.includes(KEY), false);
    if (metadata?.model) assert.ok(html.includes(metadata.model));
  }
});
