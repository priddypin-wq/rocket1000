// Real no-login HTTP/session/ZIP test. Fixture telemetry is not an MT5 terminal.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { market } from "../tests/helpers.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
const root = process.cwd();
await mkdir(join(root, "work"), { recursive: true });
const directory = await mkdtemp(join(root, "work", "http-integration-"));
const port = 3100;
const base = `http://localhost:${port}`;
Object.assign(process.env, {
  NODE_ENV: "development",
  ROCKET_DASHBOARD_URL: base,
  SQLITE_PATH: join(directory, "test.sqlite"),
  ROCKET_BACKEND_URL: "https://integration.example.test",
});
process.env.DATABASE_URL = "";
process.env.VERCEL = "";
process.env.ROCKET_REQUIRE_POSTGRES = "";
// Explicit empty values also prevent Next from loading real credentials from
// .env.local. This fixture test must never spend inherited provider credits.
process.env.OPENAI_API_KEY = "";
process.env.AI_GATEWAY_API_KEY = "";
process.env.VERCEL_OIDC_TOKEN = "";
process.env.ROCKET_OPENAI_SERVER_MANAGED = "1";
process.env.ROCKET_OPENAI_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
  "base64",
);
process.env.ROCKET_ENGINE_CRON_SECRET = "";
const { getDatabase, migrateConnections } =
  await import("../server/database.mjs");
const db = getDatabase();
await migrateConnections(db);
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    // The Windows test sandbox cannot use Turbopack's native path canonicalizer.
    ...(process.platform === "win32" ? ["--webpack"] : []),
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);
let output = "";
child.stdout.on("data", (c) => {
  output = (output + c).slice(-16000);
});
child.stderr.on("data", (c) => {
  output = (output + c).slice(-16000);
});
const request = (
  path,
  {
    cookie,
    body,
    origin = base,
    method = body === undefined ? "GET" : "POST",
    headers = {},
  } = {},
) =>
  fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function initialize() {
  const r = await request("/api/mt5/session", { method: "POST" });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true });
  const cookies = r.headers.getSetCookie();
  assert.ok(cookies[0].includes("HttpOnly"));
  assert.ok(cookies[0].includes("SameSite=Strict"));
  return cookies.map((v) => v.split(";")[0]).join("; ");
}
let checks = 0;
const passed = (label) => {
  checks++;
  console.log(`PASS ${label}`);
};
try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw Error("Next dev exited");
    try {
      const r = await fetch(base);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(ready, "Server startup timed out");
  const page = await request("/mt5");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Download Rocket1000 EA (.ex5)"));
  assert.ok(!/type="(?:email|password)"/.test(html));
  passed("direct MT5 page accessible without email, password or registration");
  assert.equal(
    (await request("/api/auth/sign-up/email", { body: {} })).status,
    404,
  );
  passed("old sign-up endpoint removed");
  assert.equal((await request("/api/mt5/connections")).status, 401);
  passed("private status cannot be read without its browser cookie");
  assert.equal((await request("/api/mt5/analysis")).status, 401);
  passed("market data and analysis require the private browser cookie");
  assert.equal((await request("/api/mt5/orders")).status, 401);
  assert.equal((await request("/api/mt5/reports?format=json")).status, 401);
  assert.equal((await request("/api/mt5/reports?format=csv")).status, 401);
  passed("owned orders and EA symbols require the private browser cookie");
  for (const path of ["engine", "openai"]) {
    assert.equal((await request(`/api/mt5/${path}`)).status, 401);
    assert.equal(
      (await request(`/api/mt5/${path}`, { body: { action: "test" } })).status,
      401,
    );
  }
  passed(
    "AI engine and saved-key endpoints require the private browser cookie",
  );
  assert.equal((await request("/api/mt5/ai-connection")).status, 401);
  assert.equal(
    (await request("/api/mt5/ai-connection", { body: {} })).status,
    401,
  );
  passed("AI connection status and probes require the private browser cookie");
  assert.equal((await request("/api/mt5/trading")).status, 401);
  assert.equal(
    (await request("/api/mt5/trading", { body: { action: "prepare-live" } }))
      .status,
    401,
  );
  assert.equal((await request("/api/ea/authorize", { body: {} })).status, 401);
  passed(
    "order controls and EA authorization require their separate credentials",
  );
  const settings = await request("/settings");
  const settingsHtml = await settings.text();
  assert.ok(
    settings.url.endsWith("/") ||
      settings.url.endsWith("/#ai-configuration") ||
      settingsHtml.includes("/#ai-configuration"),
  );
  passed(
    "the old Settings route opens the single private engine configuration drawer",
  );
  for (const path of ["/", "/dashboard", "/mt5", "/settings"]) {
    const screen = await (await request(path)).text();
    assert.ok(
      !/<(?:canvas|iframe)\b|TradingView|Chat with AI|Start voice/i.test(
        screen,
      ),
    );
    for (const label of ["Home", "Market", "MT5"])
      assert.ok(screen.includes(label));
    const nav = screen.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)?.[0] || "";
    assert.equal((nav.match(/<a\b/g) || []).length, 3);
    assert.ok(!nav.includes("Settings"));
  }
  const home = await (await request("/")).text();
  assert.ok(home.includes("Enable Auto Trading"));
  assert.ok(home.includes("Emergency Stop"));
  assert.ok(home.includes("AI LIVE ANALYSIS"));
  assert.ok(home.includes("ACTIVE STRATEGY"));
  assert.ok(home.includes("NEXT SIGNAL / OPEN ORDERS"));
  assert.ok(!home.includes('class="inner-card scalp-summary"'));
  assert.ok(!home.includes('class="inner-card engine-activity"'));
  assert.ok(!home.includes("Estimated API usage today"));
  passed(
    "three main screens retain explicit Auto Trading and Emergency Stop; selected legacy Home cards and cost counters are absent",
  );
  assert.equal(
    (
      await request("/api/mt5/session", {
        method: "POST",
        origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  passed("cross-origin session creation rejected");
  const anonymousSession = await request("/api/mt5/session");
  assert.equal(anonymousSession.status, 401);
  assert.equal(
    (await anonymousSession.json()).code,
    "BROWSER_SESSION_REQUIRED",
  );
  assert.equal(anonymousSession.headers.getSetCookie().length, 0);
  passed("read-only session probe never creates an anonymous connection");
  const alice = await initialize();
  const bob = await initialize();
  const sessionsBeforeProbe = await db.query(
    "SELECT token_hash,workspace_id FROM rocket_browser_sessions ORDER BY workspace_id",
  );
  const existingSession = await request("/api/mt5/session", { cookie: alice });
  assert.equal(existingSession.status, 200);
  assert.deepEqual(await existingSession.json(), { ok: true });
  assert.equal(existingSession.headers.getSetCookie().length, 0);
  assert.ok(existingSession.headers.get("cache-control").includes("no-store"));
  assert.deepEqual(
    await db.query(
      "SELECT token_hash,workspace_id FROM rocket_browser_sessions ORDER BY workspace_id",
    ),
    sessionsBeforeProbe,
  );
  passed(
    "session reuse preserves the existing private identity and credential",
  );
  for (const [path, body] of [
    ["openai", { action: "save", key: "fixture-never-an-api-key" }],
    ["engine", { action: "start" }],
  ]) {
    assert.equal(
      (
        await request(`/api/mt5/${path}`, {
          cookie: alice,
          body,
          origin: "https://attacker.example",
        })
      ).status,
      403,
    );
  }
  passed(
    "cross-origin key saving and engine actions are rejected before state changes",
  );
  const insecureKey = await request("/api/mt5/openai", {
    cookie: alice,
    body: { action: "save", key: "fixture-never-an-api-key" },
  });
  assert.equal(insecureKey.status, 400);
  const insecureResult = await insecureKey.json();
  assert.equal(insecureResult.code, "OPENAI_HTTPS_REQUIRED");
  assert.ok(
    !JSON.stringify(insecureResult).includes("fixture-never-an-api-key"),
  );
  passed(
    "HTTP key saving fails closed without reflecting the submitted fixture key",
  );
  const keyMetadata = await request("/api/mt5/openai", { cookie: alice });
  assert.equal(keyMetadata.status, 200);
  assert.ok(keyMetadata.headers.get("cache-control").includes("no-store"));
  const keyState = await keyMetadata.json();
  assert.equal(keyState.configured, false);
  assert.equal(keyState.stored, false);
  assert.equal(keyState.connection.connected, false);
  assert.ok(
    !/ciphertext|nonce|tag|apiKey|api_key/.test(JSON.stringify(keyState)),
  );
  passed("saved-key metadata is private and never returns credential material");
  const initialEngineResponse = await request("/api/mt5/engine", {
    cookie: alice,
  });
  assert.equal(initialEngineResponse.status, 200);
  const initialEngine = await initialEngineResponse.json();
  assert.equal(initialEngine.state, "stopped");
  assert.equal(initialEngine.scheduler.configured, false);
  assert.equal(initialEngine.usage.estimatedUsd, 0);
  assert.equal(initialEngine.usage.reservedUsd, 0);
  assert.equal(initialEngine.usage.inputTokens, 0);
  assert.equal(initialEngine.usage.outputTokens, 0);
  passed(
    "engine status reports stopped with no real scheduler and zero actual API usage",
  );
  for (const settings of [
    { frequencySeconds: 10, dailyBudgetUsd: 1 },
    { frequencySeconds: 60, dailyBudgetUsd: 100 },
    { frequencySeconds: 60.5, dailyBudgetUsd: 1 },
  ]) {
    assert.equal(
      (
        await request("/api/mt5/engine", {
          cookie: alice,
          body: { action: "configure", ...settings },
        })
      ).status,
      422,
    );
  }
  passed("server rejects out-of-range budgets and analysis frequency");
  assert.equal(
    (
      await request("/api/mt5/ai-connection", {
        cookie: alice,
        body: {},
        origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  passed("cross-origin AI probes are rejected before a provider request");
  const nonDiagnosticTables = [
    "rocket_direct_connections",
    "rocket_direct_installations",
    "rocket_market_snapshots",
    "rocket_execution",
    "rocket_analyses",
    "rocket_ai_health",
    "rocket_trade_policy",
    "rocket_trade_preferences",
    "rocket_order_previews",
    "rocket_trade_commands",
    "rocket_live_consents",
    "rocket_live_approvals",
    "rocket_automation",
    "rocket_engine_validation",
  ];
  const tradingSnapshot = async () =>
    Promise.all(
      nonDiagnosticTables.map((table) =>
        db.query(`SELECT * FROM ${table} ORDER BY 1`),
      ),
    );
  const beforeConnectionTest = await tradingSnapshot();
  const beforeChecks = await db.query(
    "SELECT * FROM rocket_ai_connection_checks",
  );
  const beforeBudget = await db.query(
    "SELECT * FROM rocket_ai_connection_budget",
  );
  for (const cookie of [alice, bob]) {
    const status = await request("/api/mt5/ai-connection", { cookie });
    assert.equal(status.status, 200);
    assert.ok(status.headers.get("cache-control").includes("no-store"));
    const state = await status.json();
    assert.equal(state.configured, false);
    assert.equal(state.connected, false);
    assert.equal(state.state, "unconfigured");
    assert.equal(state.checkedAt, null);
    assert.equal(state.lastSuccessAt, null);
    assert.ok(!JSON.stringify(state).includes("apiKey"));
  }
  assert.deepEqual(
    await db.query("SELECT * FROM rocket_ai_connection_checks"),
    beforeChecks,
  );
  assert.deepEqual(
    await db.query("SELECT * FROM rocket_ai_connection_budget"),
    beforeBudget,
  );
  passed(
    "private AI status is uncached and never sends a probe or writes test history",
  );
  for (const body of [
    null,
    [],
    { apiKey: "fixture-never-echo-this" },
    { model: "other" },
    { input: "BUY" },
  ]) {
    const invalid = await request("/api/mt5/ai-connection", {
      cookie: alice,
      body,
    });
    assert.equal(invalid.status, 400);
    const rejected = await invalid.json();
    assert.equal(rejected.code, "AI_TEST_INVALID_INPUT");
    assert.ok(!JSON.stringify(rejected).includes("fixture-never-echo-this"));
  }
  assert.equal(
    (
      await request("/api/mt5/ai-connection", {
        cookie: alice,
        body: { padding: "x".repeat(129) },
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await request("/api/mt5/ai-connection", {
        cookie: alice,
        body: {},
        headers: { "Content-Type": "text/plain" },
      })
    ).status,
    415,
  );
  passed(
    "AI probes reject browser credentials, arbitrary prompts/models and invalid or oversized input",
  );
  const noCredentialTest = await request("/api/mt5/ai-connection", {
    cookie: alice,
    body: {},
  });
  assert.equal(noCredentialTest.status, 503);
  assert.equal((await noCredentialTest.json()).code, "AI_AUTH_REQUIRED");
  assert.deepEqual(await tradingSnapshot(), beforeConnectionTest);
  assert.deepEqual(
    await db.query("SELECT * FROM rocket_ai_connection_checks"),
    beforeChecks,
  );
  assert.deepEqual(
    await db.query("SELECT * FROM rocket_ai_connection_budget"),
    beforeBudget,
  );
  passed(
    "connection diagnostics fail closed without credentials and never alter trading or account authorization",
  );
  assert.equal(
    (
      await request("/api/mt5/trading", {
        cookie: alice,
        body: { action: "enable" },
        origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  passed("cross-origin trading commands are rejected");
  for (const action of ["prepare-live", "confirm-live"])
    assert.equal(
      (
        await request("/api/mt5/trading", {
          cookie: alice,
          body: { action, acknowledgedRisk: true },
          origin: "https://attacker.example",
        })
      ).status,
      403,
    );
  passed(
    "Live review and activation reject cross-origin requests before creating approval",
  );
  assert.notEqual(alice, bob);
  passed("private browser sessions created automatically without accounts");
  const repeated = await request("/api/mt5/session", {
    method: "POST",
    cookie: alice,
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.headers.getSetCookie().length, 0);
  passed("initialization is idempotent for an existing cookie");
  let data = await (
    await request("/api/mt5/connections", { cookie: alice })
  ).json();
  const id = data.connections[0].id;
  assert.equal(data.serverUrl, null);
  assert.equal(data.downloadReady, false);
  assert.equal(data.connections[0].status, "Disconnected");
  assert.equal(data.connections[0].expectedLogin, null);
  const again = await (
    await request("/api/mt5/connections", { cookie: alice })
  ).json();
  assert.equal(again.connections[0].id, id);
  const pageConnection = await Promise.all(
    ["/", "/dashboard", "/mt5"].map(async (path) => {
      assert.equal((await request(path, { cookie: alice })).status, 200);
      const state = await (
        await request("/api/mt5/connections", { cookie: alice })
      ).json();
      assert.equal(state.connections.length, 1);
      return state.connections[0].id;
    }),
  );
  assert.deepEqual(pageConnection, [id, id, id]);
  passed("Home, Market and MT5 reuse exactly one private connection");
  passed(
    "connection allocated automatically; unverified URL and download stay unavailable",
  );
  assert.equal(
    (await request("/api/mt5/connections", { cookie: alice, body: {} })).status,
    405,
  );
  passed("manual connection provisioning endpoint removed");
  assert.equal(
    (
      await request("/api/mt5/download", {
        cookie: bob,
        body: { connectionId: id },
      })
    ).status,
    404,
  );
  passed("another browser cannot download this connection");
  assert.equal(
    (
      await request("/api/mt5/download", {
        cookie: alice,
        origin: "https://attacker.example",
        body: { connectionId: id },
      })
    ).status,
    403,
  );
  passed("cross-origin credential issuance rejected");
  assert.equal(
    (
      await request("/api/mt5/download", {
        cookie: alice,
        body: { connectionId: id },
      })
    ).status,
    409,
  );
  passed("personalized download requires a verified HTTPS connection");
  const failedGeneration = await request("/api/mt5/generate", {
    cookie: alice,
    body: {},
  });
  assert.equal(failedGeneration.status, 503);
  assert.equal((await failedGeneration.json()).code, "DEPLOYMENT_UNREACHABLE");
  passed("Generate rejects an unreachable HTTPS backend");
  assert.equal((await request("/api/health")).status, 200);
  passed("backend exposes its health protocol");
  // Fixture proof permits testing ZIP and EA routes without pretending the fixture host is deployed.
  await db.query(
    "INSERT INTO rocket_generated_connections(connection_id,server_url,verified_at) VALUES(?,?,?)",
    [id, "https://integration.example.test", Date.now()],
  );
  data = await (
    await request("/api/mt5/connections", { cookie: alice })
  ).json();
  assert.equal(data.serverUrl, "https://integration.example.test");
  assert.equal(data.downloadReady, true);
  let r = await request("/api/mt5/download", {
    cookie: alice,
    body: { connectionId: id, format: "package" },
  });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(r.headers.get("content-type"), "application/zip");
  assert.ok(r.headers.get("cache-control").includes("no-store"));
  const entries = unzipSync(new Uint8Array(await r.arrayBuffer()));
  assert.ok(entries["MQL5/Experts/ROCKET1000/ROCKET1000_EA.ex5"].length > 1024);
  const config = strFromU8(entries["MQL5/Files/ROCKET1000/rocket1000.config"]);
  const token = config.match(/^credential=(.+)$/m)[1];
  assert.ok(config.includes("backend_url=https://integration.example.test"));
  passed(
    "real compiled EA delivered with a unique token and matching server URL",
  );
  const telemetry = {
    accountLogin: "12345678",
    brokerServer: "Broker-Live",
    accountType: "live",
    terminalBuild: 5000,
    brokerConnected: true,
    eaProtocol: 4,
    terminalSession: "abcdef0123456789abcdef01",
    chartSymbol: "XAUUSD",
    authorizedSymbols: ["XAUUSD"],
    instanceId: "0123456789abcdef01234567abcd",
    execution: {
      protocol: 4,
      engineVersion: ENGINE_VERSION,
      terminalId: "0123456789abcdef01234567",
      tickSize: 0.01,
      tickValue: 1,
      point: 0.01,
      volumeStep: 0.01,
      minVolume: 0.01,
      maxVolume: 10,
      stopLevel: 10,
      freezeLevel: 5,
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
      realizedToday: -7.18,
    },
  };
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal(
    (await request("/api/ea/register?token=not-a-header", { body: telemetry }))
      .status,
    401,
  );
  passed("EA credentials required in headers, never accepted from URLs");
  r = await request("/api/ea/register", {
    headers,
    body: { ...telemetry, market: market(Date.now()) },
  });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).tradingEnabled, false);
  data = await (
    await request("/api/mt5/connections", { cookie: alice })
  ).json();
  assert.equal(data.connections[0].status, "Connected");
  assert.equal(data.connections[0].installation.accountLogin, "12345678");
  assert.ok(!JSON.stringify(data).includes(token));
  passed(
    "first EA registration binds account and reports a real server-received heartbeat",
  );
  for (const patch of [
    { instanceId: "0123456789abcdef01234567eeee" },
    {
      execution: {
        ...telemetry.execution,
        terminalId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      },
      instanceId: "aaaaaaaaaaaaaaaaaaaaaaaaffff",
      accountLogin: "87654321",
    },
  ]) {
    const conflict = await request("/api/ea/register", {
      headers,
      body: { ...telemetry, ...patch, market: market(Date.now()) },
    });
    assert.equal(conflict.status, 409, await conflict.clone().text());
    assert.equal((await conflict.json()).code, "EA_CONNECTION_IN_USE");
  }
  const preservedConnection = await (
    await request("/api/mt5/connections", { cookie: alice })
  ).json();
  assert.equal(preservedConnection.connections.length, 1);
  assert.equal(preservedConnection.connections[0].id, id);
  assert.equal(preservedConnection.connections[0].status, "Connected");
  assert.equal(
    preservedConnection.connections[0].installation.accountLogin,
    "12345678",
  );
  assert.equal(
    (
      await request("/api/ea/heartbeat", {
        headers,
        body: { ...telemetry, market: market(Date.now()) },
      })
    ).status,
    200,
  );
  passed(
    "competing EA copies cannot replace or interrupt the authenticated MT5 connection",
  );
  const ownerOrders = await (
    await request("/api/mt5/orders", { cookie: alice })
  ).json();
  assert.deepEqual(
    ownerOrders.authorizedSymbols.map((s) => s.symbol),
    ["XAUUSD"],
  );
  assert.deepEqual(ownerOrders.positions, []);
  assert.deepEqual(ownerOrders.opportunities, []);
  assert.ok(!JSON.stringify(ownerOrders).includes(token));
  passed(
    "orders API exposes only the authenticated EA symbol and actual empty broker positions",
  );
  const visitorOrders = await (
    await request("/api/mt5/orders", { cookie: bob })
  ).json();
  assert.deepEqual(visitorOrders.authorizedSymbols, []);
  assert.deepEqual(visitorOrders.positions, []);
  passed(
    "orders API isolates broker symbols and positions between browser workspaces",
  );
  // Actual valid OHLCV precision makes the four-frame fixture exceed the old
  // 64 KiB limit. No padding fields or invalid extra history are needed.
  const denseMarket = market(Date.now());
  for (const frame of Object.values(denseMarket.timeframes))
    frame.bars = frame.bars.map((bar) => ({
      ...bar,
      open: bar.open + 0.1234567890123,
      close: bar.close + 0.1234567890123,
      high: bar.high + 0.1234567890123,
      low: bar.low + 0.1234567890123,
      volume: bar.volume + 0.1234567890123,
    }));
  denseMarket.bars = structuredClone(denseMarket.timeframes.M5.bars);
  assert.deepEqual(Object.keys(denseMarket.timeframes), [
    "M1",
    "M5",
    "M15",
    "H1",
  ]);
  const denseTelemetry = { ...telemetry, market: denseMarket };
  const denseBytes = Buffer.byteLength(JSON.stringify(denseTelemetry));
  assert.ok(denseBytes > 65536 && denseBytes < 196608);
  r = await request("/api/ea/heartbeat", { headers, body: denseTelemetry });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).tradingEnabled, false);
  passed(
    "valid four-timeframe history over 64 KiB reaches the backend with trading disabled",
  );
  r = await request("/api/ea/heartbeat", {
    // A rejected streaming upload can close its socket before the client has
    // finished sending. Do not reuse that deliberately oversized connection.
    headers: { ...headers, Connection: "close" },
    body: { ...denseTelemetry, padding: "x".repeat(1048576) },
  });
  assert.equal(r.status, 413, await r.clone().text());
  assert.equal((await r.json()).error, "Request too large");
  passed("EA requests exceeding 1 MiB are rejected before telemetry ingestion");
  const other = await (
    await request("/api/mt5/connections", { cookie: bob })
  ).json();
  assert.equal(other.connections[0].installation, null);
  assert.notEqual(other.connections[0].id, id);
  passed("other visitors cannot see private account details");
  const analysis = await (
    await request("/api/mt5/analysis", { cookie: alice })
  ).json();
  assert.equal(analysis.market.symbol, "XAUUSD");
  assert.equal(
    analysis.market.bars.length,
    denseMarket.timeframes.M5.bars.length,
  );
  assert.deepEqual(analysis.market.bars, denseMarket.timeframes.M5.bars);
  for (const name of ["M1", "M5", "M15", "H1"])
    assert.deepEqual(
      analysis.market.timeframes[name].bars,
      denseMarket.timeframes[name].bars,
    );
  assert.equal(analysis.market.fresh, true);
  assert.equal(analysis.latest, null);
  const privateAnalysis = await (
    await request("/api/mt5/analysis", { cookie: bob })
  ).json();
  assert.equal(privateAnalysis.market, null);
  passed("authenticated terminal candles reach only their owning browser");
  // Warm the actual export route before sending its freshness-sensitive broker
  // fixture. Slow development compilation must not require weaker quote limits.
  await request("/api/mt5/reports?format=json", { cookie: alice });
  denseMarket.timestamp = Date.now();
  denseMarket.brokerTimestamp = denseMarket.timestamp;
  denseMarket.quoteTimestamp = denseMarket.timestamp;
  r = await request("/api/ea/heartbeat", { headers, body: denseTelemetry });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).tradingEnabled, false);
  const reportResponse = await request("/api/mt5/reports?format=json", {
    cookie: alice,
  });
  assert.equal(reportResponse.status, 200);
  assert.ok(reportResponse.headers.get("cache-control").includes("no-store"));
  const report = await reportResponse.json();
  assert.equal(report.account.login, telemetry.accountLogin);
  assert.equal(report.chart.symbol, denseMarket.symbol);
  assert.deepEqual(
    report.chart.timeframes.M5.bars,
    denseMarket.timeframes.M5.bars,
  );
  assert.ok(!JSON.stringify(report).includes(token));
  const visitorReport = await (
    await request("/api/mt5/reports?format=json", { cookie: bob })
  ).json();
  assert.equal(visitorReport.account, null);
  assert.equal(visitorReport.chart, null);
  passed(
    "private reports expose only the authenticated account and real EA candle payload",
  );
  const csvReport = await request("/api/mt5/reports?format=csv&download=1", {
    cookie: alice,
  });
  assert.equal(csvReport.status, 200);
  assert.ok(
    csvReport.headers.get("content-disposition").includes("attachment"),
  );
  const csvText = await csvReport.text();
  assert.ok(csvText.includes(denseMarket.symbol));
  assert.ok(!csvText.includes(token));
  passed("private CSV export downloads actual broker data without credentials");
  const start = await request("/api/mt5/engine", {
    cookie: alice,
    body: { action: "start" },
  });
  assert.equal(start.status, 503, await start.clone().text());
  assert.equal((await start.json()).code, "AI_SCHEDULER_NOT_READY");
  const legacyStart = await request("/api/mt5/analysis", {
    cookie: alice,
    body: {},
  });
  assert.equal(legacyStart.status, 503);
  assert.equal((await legacyStart.json()).code, "AI_SCHEDULER_NOT_READY");
  const failed = await (
    await request("/api/mt5/analysis", { cookie: alice })
  ).json();
  assert.equal(failed.latest, null);
  passed(
    "START AI and its legacy alias fail closed without a real background scheduler and create no fake analysis",
  );
  let liveState = await (
    await request("/api/mt5/trading", { cookie: alice })
  ).json();
  for (const action of ["prepare-live", "confirm-live"]) {
    const unauthorized = await request("/api/mt5/trading", {
      cookie: alice,
      body: { action, accountKey: liveState.accountKey },
    });
    assert.equal(unauthorized.status, action === "prepare-live" ? 409 : 400);
  }
  passed(
    "Live authorization rejects malformed review inputs and confirmation without a valid bounded review",
  );
  assert.equal(
    (await request("/api/mt5/stop", { cookie: alice, body: {} })).status,
    200,
  );
  liveState = await (
    await request("/api/mt5/trading", { cookie: alice })
  ).json();
  assert.equal(liveState.permissionActive, false);
  assert.equal(liveState.orders.length, 0);
  passed(
    "Emergency Stop revokes unified execution and leaves existing positions alone",
  );
  assert.equal(
    (
      await request("/api/ea/heartbeat", {
        headers,
        body: { ...telemetry, accountType: "demo" },
      })
    ).status,
    403,
  );
  passed("bound account mismatch rejected");
  assert.equal(
    (await request("/api/ea/register", { headers, body: telemetry })).status,
    200,
  );
  assert.equal(
    (await request("/api/ea/heartbeat", { headers, body: telemetry })).status,
    200,
  );
  passed("reconnection stays trading-disabled");
  assert.equal(
    (await request("/api/mt5/stop", { cookie: alice, body: {} })).status,
    200,
  );
  passed("existing emergency-stop control works without login");
  assert.equal(
    (
      await request("/api/mt5/revoke", {
        cookie: alice,
        body: { connectionId: id },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/ea/heartbeat", { headers, body: telemetry })).status,
    401,
  );
  passed("revocation immediately rejects the credential");
  const singleFile = await request("/api/mt5/download", {
    cookie: alice,
    body: { connectionId: id },
  });
  assert.equal(singleFile.status, 200);
  assert.ok(singleFile.headers.get("content-type").startsWith("text/x-mql5"));
  assert.ok(
    singleFile.headers
      .get("content-disposition")
      .includes('filename="ROCKET1000_EA.mq5"'),
  );
  assert.ok(singleFile.headers.get("cache-control").includes("no-store"));
  const personalizedSource = await singleFile.text();
  assert.ok(!/FileOpen\s*\(|rocket1000\.config/.test(personalizedSource));
  const sourceToken = personalizedSource.match(
    /const string token="([A-Za-z0-9_.-]+)";/,
  )?.[1];
  assert.ok(/^r1000\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(sourceToken));
  assert.ok(
    personalizedSource.includes(
      'const string url="https://integration.example.test";',
    ),
  );
  const sourceRegistration = await request("/api/ea/register", {
    headers: { Authorization: `Bearer ${sourceToken}` },
    body: telemetry,
  });
  assert.equal(sourceRegistration.status, 200);
  assert.equal((await sourceRegistration.json()).tradingEnabled, false);
  passed(
    "default download is a private self-contained MetaEditor source with a working scoped credential",
  );
  assert.ok(personalizedSource.includes('#property version   "7.00"'));
  assert.ok(personalizedSource.includes(ENGINE_VERSION));
  assert.ok(personalizedSource.includes("TRADE_ACTION_SLTP"));
  passed(
    "download includes the compiled-version-matched 7.00 four-timeframe broker execution source",
  );
  assert.equal(
    (
      await request("/api/mt5/trading", {
        cookie: alice,
        body: { action: "start-auto" },
      })
    ).status,
    409,
  );
  const consentAttempt = await request("/api/mt5/trading", {
    cookie: alice,
    body: { action: "confirm-live", confirmation: "ENABLE LIVE 12345678" },
  });
  assert.equal(consentAttempt.status, 400);
  passed(
    "automatic trading needs current OpenAI/broker readiness; malformed Live confirmation cannot bypass Start",
  );
  assert.equal(
    (
      await request("/api/mt5/trading", {
        cookie: alice,
        body: { action: "settings", settings: { sizingMode: "unlimited" } },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await request("/api/mt5/trading", {
        cookie: alice,
        body: { action: "settings", settings: { maxDailyLossPct: 8 } },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await request("/api/mt5/trading", {
        cookie: alice,
        body: {
          action: "settings",
          settings: {
            maxDailyLossPct: 0.5,
            sizingMode: "capped",
            lotSize: 0.02,
          },
        },
      })
    ).status,
    200,
  );
  let tradingState = await (
    await request("/api/mt5/trading", { cookie: alice })
  ).json();
  assert.equal(tradingState.settings.maxDailyLossPct, 0.5);
  assert.equal(tradingState.settings.sizingMode, "capped");
  assert.equal(tradingState.settings.lotSize, 0.02);
  assert.equal(tradingState.liveConfirmed, false);
  assert.equal(tradingState.permissionActive, false);
  passed(
    "risk preferences persist, reject excessive limits, and leave trading disabled",
  );
  r = await request("/api/mt5/trading", {
    cookie: alice,
    body: {
      action: "settings",
      settings: { sizingMode: "adaptive", lotSize: 0.01 },
    },
  });
  assert.equal(r.status, 200, await r.clone().text());
  tradingState = await (
    await request("/api/mt5/trading", { cookie: alice })
  ).json();
  assert.equal(tradingState.settings.sizingMode, "adaptive");
  assert.equal(tradingState.permissionActive, false);
  assert.equal(tradingState.liveConfirmed, false);
  passed(
    "adaptive sizing saves independently of an optional custom cap and cannot enable trading",
  );
  const configuredEngine = await request("/api/mt5/engine", {
    cookie: alice,
    body: { action: "configure", frequencySeconds: 120, dailyBudgetUsd: 0.5 },
  });
  assert.equal(
    configuredEngine.status,
    200,
    await configuredEngine.clone().text(),
  );
  const costLimits = await configuredEngine.json();
  assert.equal(costLimits.frequencySeconds, 120);
  assert.equal(costLimits.usage.dailyBudgetUsd, 0.5);
  assert.equal(costLimits.state, "stopped");
  passed(
    "valid server cost settings persist without starting analysis or execution",
  );
  const stopEngine = await request("/api/mt5/engine", {
    cookie: alice,
    body: { action: "stop" },
  });
  assert.equal(stopEngine.status, 200, await stopEngine.clone().text());
  assert.equal((await stopEngine.json()).state, "stopped");
  const persistedStop = await (
    await request("/api/mt5/engine", { cookie: alice })
  ).json();
  assert.equal(persistedStop.state, "stopped");
  assert.equal(persistedStop.usage.estimatedUsd, 0);
  assert.equal(persistedStop.usage.reservedUsd, 0);
  const stoppedTrading = await (
    await request("/api/mt5/trading", { cookie: alice })
  ).json();
  assert.equal(stoppedTrading.permissionActive, false);
  assert.deepEqual(stoppedTrading.orders, []);
  passed(
    "STOP AI persists stopped state, revokes order submission and leaves no broker orders",
  );
  await request("/api/mt5/revoke", {
    cookie: alice,
    body: { connectionId: id },
  });
  console.log(
    `${checks} no-login HTTP integration checks passed. The HTTPS host and terminal payload are fixtures, not an actual MT5 connection.`,
  );
} catch (error) {
  console.error(output);
  throw error;
} finally {
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once("exit", resolve);
      setTimeout(resolve, 5000);
    }
  });
  await db.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 500,
  });
}
