import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { openDatabase, migrateConnections } from "../server/database.mjs";
import {
  provisioningService,
  backendOrigin,
  compiledArtifact,
  HEARTBEAT_TIMEOUT_MS,
} from "../server/provisioning.mjs";
import { personalizedEaSource } from "../server/ea-source.mjs";
const account = {
  label: "Live terminal",
  accountLogin: "12345678",
  brokerServer: "Broker-Live",
  accountType: "live",
};
const telemetry = {
  accountLogin: account.accountLogin,
  brokerServer: account.brokerServer,
  accountType: "live",
  terminalBuild: 5000,
  brokerConnected: true,
};
async function fixture(filename = ":memory:") {
  const db = openDatabase({ filename });
  await migrateConnections(db);
  for (const id of ["alice", "bob"])
    await db.query(
      "INSERT INTO rocket_workspaces(id,created_at,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
      [id, 1800000000000, 1900000000000],
    );
  let clock = 1800000000000;
  const service = provisioningService(db, {
    now: () => clock,
    origin: () => "https://integration.example.test",
  });
  return {
    db,
    service,
    advance: (ms) => {
      clock += ms;
    },
  };
}
function config(zip) {
  const entries = unzipSync(zip);
  const c = Object.fromEntries(
    strFromU8(entries["MQL5/Files/ROCKET1000/rocket1000.config"])
      .trim()
      .split("\n")
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
  return { entries, ...c };
}
test("canonical origin fails closed and never uses request host", () => {
  for (const value of [
    undefined,
    "http://example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://example.com/path",
    "https://a:b@example.com",
    "https://example.com?token=x",
  ])
    assert.throws(
      () => backendOrigin({ ROCKET_BACKEND_URL: value }),
      (e) => e.status === 503,
    );
  assert.equal(
    backendOrigin({ ROCKET_BACKEND_URL: "https://rocket.example.com/" }),
    "https://rocket.example.com",
  );
});
test("real compiled artifact matches source and build manifest", async () => {
  const { binary, manifest } = await compiledArtifact();
  assert.ok(binary.length > 1024);
  assert.equal(manifest.errors, 0);
  assert.equal(manifest.name, "ROCKET1000 EA");
});

test("one-file MetaEditor download embeds a scoped credential without a config dependency", async () => {
  const { db, service } = await fixture();
  try {
    const { id } = await service.create("alice");
    await assert.rejects(
      () => service.download("bob", id, { format: "source" }),
      (e) => e.status === 404,
    );
    const source = Buffer.from(
      await service.download("alice", id, { format: "source" }),
    ).toString("utf8");
    assert.ok(
      !/FileOpen\s*\(|rocket1000\.config|CONFIG_BEGIN|CONFIG_END/.test(source),
    );
    assert.ok(
      source.includes('const string url="https://integration.example.test";'),
    );
    const token = source.match(/const string token="([A-Za-z0-9_.-]+)";/)?.[1];
    assert.ok(/^r1000\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token));
    assert.ok(source.includes(`const string id="${token.split(".")[1]}";`));
    assert.ok(source.includes("Compile (F7)"));
    assert.equal(
      (await service.telemetry(token, telemetry, true)).tradingEnabled,
      false,
    );
    assert.ok(!JSON.stringify(await service.list("alice")).includes(token));
    assert.ok(!JSON.stringify(await service.logs("alice")).includes(token));
    const broken = provisioningService(db, {
      now: () => 1800000000000,
      origin: () => "https://integration.example.test",
      artifact: async () => ({
        ...(await compiledArtifact()),
        source: Buffer.from("invalid template"),
      }),
    });
    await assert.rejects(
      () => broken.download("alice", id, { format: "source" }),
      (e) => e.status === 503,
    );
    await assert.rejects(
      () => service.download("alice", id, { format: "unknown" }),
      (e) => e.status === 400,
    );
    assert.equal((await service.telemetry(token, telemetry, false)).ok, true);
    const replacement = Buffer.from(
      await service.download("alice", id, { format: "source" }),
    ).toString("utf8");
    const nextToken = replacement.match(
      /const string token="([A-Za-z0-9_.-]+)";/,
    )?.[1];
    assert.notEqual(nextToken, token);
    await assert.rejects(
      () => service.telemetry(token, telemetry, true),
      (e) => e.status === 401,
    );
    assert.equal(
      (await service.telemetry(nextToken, telemetry, true)).ok,
      true,
    );
  } finally {
    await db.close();
  }
});

test("source personalization rejects injected connection values and malformed templates", async () => {
  const { source } = await compiledArtifact();
  const id = "12345678-1234-4123-8123-123456789abc";
  const params = {
    source,
    serverUrl: "https://example.test",
    installationId: id,
    credential: `r1000.${id}.${"A".repeat(43)}`,
    expiresAt: 1900000000000,
  };
  for (const patch of [
    { serverUrl: 'https://example.test"; evil()' },
    { credential: 'bad"token' },
    { installationId: "invalid" },
    { source: Buffer.from("no loader") },
  ])
    assert.throws(
      () => personalizedEaSource({ ...params, ...patch }),
      (e) => e.status === 503,
    );
});
test("personalized ZIP, ownership, registration, heartbeat expiry, restart, mismatch, revocation", async () => {
  const { db, service, advance } = await fixture();
  try {
    const { id } = await service.create("alice", account);
    assert.equal((await service.list("alice"))[0].status, "Disconnected");
    await assert.rejects(
      () => service.download("bob", id),
      (e) => e.status === 404,
    );
    assert.deepEqual(await service.list("bob"), []);
    const first = config(await service.download("alice", id));
    assert.equal(first.backend_url, "https://integration.example.test");
    assert.ok(
      first.entries["MQL5/Experts/ROCKET1000/ROCKET1000_EA.ex5"].length > 1024,
    );
    assert.ok(
      strFromU8(first.entries["INSTALL.txt"]).includes(
        "No token, URL, password or DLL input",
      ),
    );
    assert.equal((await service.list("alice"))[0].status, "Connecting");
    const [stored] = await db.query(
      "SELECT token_hash FROM rocket_direct_installations WHERE id=?",
      [first.installation_id],
    );
    assert.notEqual(stored.token_hash, first.credential);
    assert.equal(stored.token_hash.length, 64);
    await assert.rejects(
      () => service.telemetry(first.credential, telemetry, false),
      (e) => e.code === "REGISTRATION_REQUIRED",
    );
    assert.equal(
      (await service.telemetry(first.credential, telemetry, true))
        .tradingEnabled,
      false,
    );
    let row = (await service.list("alice"))[0];
    assert.equal(row.status, "Connected");
    assert.equal(row.installation.accountLogin, account.accountLogin);
    assert.equal(row.tradingEnabled, false);
    advance(HEARTBEAT_TIMEOUT_MS + 1);
    assert.equal((await service.list("alice"))[0].status, "Disconnected");
    await service.telemetry(first.credential, telemetry, true);
    assert.equal((await service.list("alice"))[0].status, "Connected");
    await assert.rejects(
      () =>
        service.telemetry(
          first.credential,
          { ...telemetry, accountLogin: "999" },
          true,
        ),
      (e) => e.code === "ACCOUNT_MISMATCH",
    );
    assert.equal((await service.list("alice"))[0].status, "Account Mismatch");
    await service.telemetry(first.credential, telemetry, true);
    await assert.rejects(
      () =>
        service.telemetry(
          first.credential,
          { ...telemetry, brokerConnected: false },
          false,
        ),
      (e) => e.code === "BROKER_DISCONNECTED",
    );
    assert.equal((await service.list("alice"))[0].status, "Disconnected");
    await service.telemetry(first.credential, telemetry, true);
    const forged =
      first.credential.slice(0, -1) +
      (first.credential.endsWith("a") ? "b" : "a");
    await assert.rejects(
      () => service.telemetry(forged, telemetry, true),
      (e) => e.status === 401,
    );
    assert.equal((await service.list("alice"))[0].status, "Connected");
    advance(1);
    const second = config(await service.download("alice", id));
    assert.notEqual(first.credential, second.credential);
    await assert.rejects(
      () => service.telemetry(first.credential, telemetry, true),
      (e) => e.status === 401,
    );
    assert.equal((await service.list("alice"))[0].status, "Connecting");
    await service.telemetry(second.credential, telemetry, true);
    await assert.rejects(
      () => service.revoke("bob", id),
      (e) => e.status === 404,
    );
    await service.revoke("alice", id);
    await assert.rejects(
      () => service.telemetry(second.credential, telemetry, true),
      (e) => e.status === 401,
    );
    assert.equal(
      (await service.list("alice"))[0].status,
      "Authentication Failed",
    );
    const logs = await service.logs("alice");
    assert.ok(logs.some((l) => l.event === "ea_registered"));
    assert.ok(logs.some((l) => l.event === "credentials_revoked"));
    assert.ok(!JSON.stringify(logs).includes(second.credential));
  } finally {
    await db.close();
  }
});
test("credential expiry, account type and broker mismatch are enforced", async () => {
  const { db, service, advance } = await fixture();
  try {
    const { id } = await service.create("alice", account);
    const c = config(await service.download("alice", id));
    await service.telemetry(c.credential, telemetry, true);
    for (const patch of [
      { accountType: "demo" },
      { brokerServer: "Another-Live" },
    ])
      await assert.rejects(
        () => service.telemetry(c.credential, { ...telemetry, ...patch }, true),
        (e) => e.status === 403,
      );
    advance(90 * 86400000);
    await assert.rejects(
      () => service.telemetry(c.credential, telemetry, true),
      (e) => e.status === 401,
    );
    assert.equal(
      (await service.list("alice"))[0].status,
      "Authentication Failed",
    );
  } finally {
    await db.close();
  }
});
test("failed packaging does not revoke an existing credential", async () => {
  const { db, service } = await fixture();
  try {
    const { id } = await service.create("alice", account);
    const c = config(await service.download("alice", id));
    const broken = provisioningService(db, {
      origin: () => "https://integration.example.test",
      artifact: async () => {
        throw new Error("artifact missing");
      },
    });
    await assert.rejects(() => broken.download("alice", id));
    await service.telemetry(c.credential, telemetry, true);
  } finally {
    await db.close();
  }
});
test("database survives process/store restart and keeps emergency stop", async () => {
  const folder = await mkdtemp(join(tmpdir(), "rocket-mt5-"));
  const filename = join(folder, "connections.sqlite");
  let db;
  try {
    const f = await fixture(filename);
    db = f.db;
    const { id } = await f.service.create("alice", account);
    const c = config(await f.service.download("alice", id));
    await f.service.telemetry(c.credential, telemetry, true);
    await f.service.stop("alice");
    await db.close();
    db = openDatabase({ filename });
    const s = provisioningService(db, { now: () => 1800000000001 });
    const row = (await s.list("alice"))[0];
    assert.equal(row.status, "Connected");
    assert.equal(row.stopped, true);
    assert.equal(row.tradingEnabled, false);
    await s.telemetry(c.credential, telemetry, true);
  } finally {
    await db?.close();
    await rm(folder, { recursive: true, force: true });
  }
});
test("concurrent replacement downloads leave exactly one usable installation", async () => {
  const { db, service } = await fixture();
  try {
    const { id } = await service.create("alice", account);
    const packages = await Promise.all([
      service.download("alice", id),
      service.download("alice", id),
    ]);
    const tokens = packages.map((p) => config(p).credential);
    const results = await Promise.allSettled(
      tokens.map((t) => service.telemetry(t, telemetry, true)),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  } finally {
    await db.close();
  }
});
test("rate limiting uses persistent counters", async () => {
  const { db, service, advance } = await fixture();
  try {
    await service.rateLimit("download:alice", 1);
    await assert.rejects(
      () => service.rateLimit("download:alice", 1),
      (e) => e.status === 429,
    );
    advance(60000);
    await service.rateLimit("download:alice", 1);
  } finally {
    await db.close();
  }
});
test("missing production backend never issues a connection credential", async () => {
  const { db, service } = await fixture();
  const previous = process.env.ROCKET_BACKEND_URL;
  delete process.env.ROCKET_BACKEND_URL;
  try {
    const { id } = await service.create("alice");
    const unavailable = provisioningService(db);
    await assert.rejects(
      () => unavailable.download("alice", id),
      (e) => e.code === "BACKEND_NOT_CONFIGURED",
    );
    const [{ n }] = await db.query(
      "SELECT COUNT(*) AS n FROM rocket_direct_installations",
    );
    assert.equal(Number(n), 0);
  } finally {
    if (previous === undefined) delete process.env.ROCKET_BACKEND_URL;
    else process.env.ROCKET_BACKEND_URL = previous;
    await db.close();
  }
});
test("simultaneous first registrations bind exactly one MT5 identity", async () => {
  const { db, service } = await fixture();
  try {
    const { id } = await service.create("alice");
    const c = config(await service.download("alice", id));
    const results = await Promise.allSettled([
      service.telemetry(c.credential, telemetry, true),
      service.telemetry(
        c.credential,
        { ...telemetry, accountLogin: "777" },
        true,
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.code,
      "ACCOUNT_MISMATCH",
    );
  } finally {
    await db.close();
  }
});
