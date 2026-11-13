import { test } from "node:test";
import assert from "node:assert/strict";
import { createMt5Client } from "../lib/mt5-session-client.mjs";
import { browserSessions } from "../server/browser-session.mjs";
import { openDatabase, migrateConnections } from "../server/database.mjs";

process.env.ROCKET_DASHBOARD_URL = "http://localhost:3000";

function sharedLocks() {
  let queue = Promise.resolve();
  return {
    request(name, options, callback) {
      assert.equal(name, "rocket1000-private-browser-session");
      assert.equal(options.mode, "exclusive");
      const running = queue.then(callback);
      queue = running.catch(() => {});
      return running;
    },
  };
}

async function fixture() {
  const db = openDatabase({ filename: ":memory:" });
  await migrateConnections(db);
  const sessions = browserSessions(db);
  const locks = sharedLocks();
  const calls = [];
  let cookie = "";
  let failInitialization = false;
  let actionFailure = null;
  const request = async (path, options) => {
    calls.push({ path, ...options });
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    const current = await sessions.read(
      new Request(`http://localhost:3000${path}`, { headers: { cookie } }),
    );
    if (path === "/api/mt5/session") {
      if (failInitialization) {
        failInitialization = false;
        throw new TypeError("Controlled network interruption");
      }
      // Keep the server read separate from cookie delivery to expose a genuine
      // concurrent-tab initialization race if the shared lock is removed.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (current) return Response.json({ ok: true });
      if (options.method === "POST") {
        const created = await sessions.create();
        cookie = created.cookie.split(";")[0];
        return Response.json({ ok: true });
      }
      return Response.json(
        {
          error: "Private connection required",
          code: "BROWSER_SESSION_REQUIRED",
        },
        { status: 401 },
      );
    }
    if (actionFailure) return Response.json(actionFailure, { status: 401 });
    if (!current)
      return Response.json(
        {
          error: "Private connection required",
          code: "BROWSER_SESSION_REQUIRED",
        },
        { status: 401 },
      );
    return Response.json({ workspace: current.id });
  };
  return {
    db,
    calls,
    client: (supported = true) =>
      createMt5Client({
        fetch: request,
        lockManager: () => (supported ? locks : undefined),
      }),
    failNextInitialization: () => (failInitialization = true),
    failAction: (error) => (actionFailure = error),
    clearCookie: () => (cookie = ""),
    setCookie: (value) => (cookie = value),
    cookie: () => cookie,
    sessionCalls: () => calls.filter((c) => c.path === "/api/mt5/session"),
  };
}

test("all concurrent screens share a single browser initialization", async () => {
  const f = await fixture();
  try {
    const tab = f.client();
    const results = await Promise.all(
      ["connections", "orders", "analysis", "engine"].map(async (path) =>
        (await tab.mt5Api(path)).json(),
      ),
    );
    assert.equal(new Set(results.map((r) => r.workspace)).size, 1);
    assert.equal(f.sessionCalls().length, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_workspaces")).length,
      1,
    );
  } finally {
    await f.db.close();
  }
});

test("simultaneously opened tabs retain one workspace and the same shared cookie", async () => {
  const f = await fixture();
  try {
    const tabs = [f.client(), f.client(), f.client()];
    const results = await Promise.all(
      tabs.map(async (tab) => (await tab.mt5Api("connections")).json()),
    );
    assert.equal(new Set(results.map((r) => r.workspace)).size, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_workspaces")).length,
      1,
    );
    assert.equal(f.sessionCalls().length, 3);
    assert.ok(f.sessionCalls().every((call) => call.method === "POST"));
  } finally {
    await f.db.close();
  }
});

test("failed initialization releases the cross-tab lock and remains retryable", async () => {
  const f = await fixture();
  try {
    const first = f.client();
    const second = f.client();
    f.failNextInitialization();
    const results = await Promise.allSettled([
      first.mt5Api("orders"),
      second.mt5Api("orders"),
    ]);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].status, "fulfilled");
    await first.mt5Api("orders");
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_workspaces")).length,
      1,
    );
    assert.equal(f.sessionCalls().length, 3);
  } finally {
    await f.db.close();
  }
});

test("without cross-tab locks an existing private connection is reused read-only", async () => {
  const f = await fixture();
  try {
    const original = await (await f.client().mt5Api("connections")).json();
    const legacy = await (await f.client(false).mt5Api("orders")).json();
    assert.equal(legacy.workspace, original.workspace);
    assert.equal(f.sessionCalls().at(-1).method, "GET");
    f.clearCookie();
    await assert.rejects(
      f.client(false).mt5Api("orders"),
      (error) => error.status === 401 && /updated browser/.test(error.message),
    );
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_workspaces")).length,
      1,
    );
    assert.equal(f.sessionCalls().filter((c) => c.method === "POST").length, 1);
  } finally {
    await f.db.close();
  }
});

test("an expired session never replays an action or silently creates a replacement connection", async () => {
  const f = await fixture();
  try {
    const tab = f.client();
    const original = await (await tab.mt5Api("connections")).json();
    const originalCookie = f.cookie();
    f.clearCookie();
    await assert.rejects(
      tab.mt5Api("engine", { action: "start" }),
      (error) => error.code === "BROWSER_SESSION_REQUIRED",
    );
    assert.equal(f.calls.filter((c) => c.path === "/api/mt5/engine").length, 1);
    await assert.rejects(
      tab.mt5Api("engine", { action: "start" }),
      (error) =>
        error.status === 401 &&
        /original connected browser/.test(error.message),
    );
    assert.equal(f.calls.filter((c) => c.path === "/api/mt5/engine").length, 1);
    assert.equal(f.sessionCalls().at(-1).method, "GET");
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_workspaces")).length,
      1,
    );
    // A restored valid cookie can recover, with no mutation automatically replayed.
    f.setCookie(originalCookie);
    const recovered = await (await tab.mt5Api("orders")).json();
    assert.equal(recovered.workspace, original.workspace);
    assert.equal(f.calls.filter((c) => c.path === "/api/mt5/engine").length, 1);
  } finally {
    await f.db.close();
  }
});

test("provider authentication errors cannot reset the browser's MT5 identity", async () => {
  const f = await fixture();
  try {
    const tab = f.client();
    const original = await (await tab.mt5Api("connections")).json();
    f.failAction({
      error: "API key rejected",
      code: "AI_AUTHENTICATION_FAILED",
    });
    await assert.rejects(
      tab.mt5Api("openai", { action: "test" }),
      (error) => error.code === "AI_AUTHENTICATION_FAILED",
    );
    f.failAction(null);
    const after = await (await tab.mt5Api("orders")).json();
    assert.equal(after.workspace, original.workspace);
    assert.equal(f.sessionCalls().length, 1);
  } finally {
    await f.db.close();
  }
});
