import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrateConnections } from "../server/database.mjs";
import {
  browserSessions,
  dashboardOrigin,
  BROWSER_LIFETIME_MS,
} from "../server/browser-session.mjs";
process.env.ROCKET_DASHBOARD_URL = "http://localhost:3000";
test("direct connection needs no registration and stores only a browser-token hash", async () => {
  const db = openDatabase({ filename: ":memory:" });
  await migrateConnections(db);
  let now = 1800000000000;
  try {
    const sessions = browserSessions(db, { now: () => now });
    const alice = await sessions.create();
    const bob = await sessions.create();
    assert.notEqual(alice.id, bob.id);
    assert.ok(alice.cookie.includes("HttpOnly"));
    assert.ok(alice.cookie.includes("SameSite=Strict"));
    const raw = alice.cookie.split(";")[0];
    const request = new Request("http://localhost:3000/api/mt5/connections", {
      headers: { cookie: raw },
    });
    assert.equal((await sessions.read(request)).id, alice.id);
    const stored = await db.query("SELECT * FROM rocket_browser_sessions");
    assert.ok(!JSON.stringify(stored).includes(raw.split("=")[1]));
    assert.equal(await sessions.read(new Request(request.url)), null);
    assert.equal(
      await sessions.read(
        new Request(request.url, {
          headers: { cookie: "rocket1000_browser=invalid" },
        }),
      ),
      null,
    );
    now += BROWSER_LIFETIME_MS;
    assert.equal(await sessions.read(request), null);
  } finally {
    await db.close();
  }
});
test("production browser cookies are Secure and host-scoped", async () => {
  const db = openDatabase({ filename: ":memory:" });
  await migrateConnections(db);
  const old = process.env.ROCKET_DASHBOARD_URL;
  process.env.ROCKET_DASHBOARD_URL = "https://rocket.example.test";
  try {
    const s = await browserSessions(db).create();
    assert.ok(s.cookie.startsWith("__Host-rocket1000_browser="));
    assert.ok(s.cookie.includes("; Secure"));
    assert.ok(!s.cookie.includes("Domain="));
  } finally {
    process.env.ROCKET_DASHBOARD_URL = old;
    await db.close();
  }
});
test("dashboard origins reject untrusted production HTTP and URLs with credentials", () => {
  for (const url of [
    "http://public.example",
    "https://a:b@example.com",
    "https://example.com/path",
  ])
    assert.throws(() =>
      dashboardOrigin({ ROCKET_DASHBOARD_URL: url, NODE_ENV: "production" }),
    );
  assert.equal(
    dashboardOrigin({
      ROCKET_DASHBOARD_URL: "http://localhost:3000",
      NODE_ENV: "development",
    }),
    "http://localhost:3000",
  );
});
