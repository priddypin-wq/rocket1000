// Verify an actual hosted ROCKET1000 instance. This never submits MT5 telemetry,
// requests AI inference, or places a trade. Any test credential is revoked.
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { backendOrigin, compiledArtifact } from "../server/provisioning.mjs";
import { createHash } from "node:crypto";

const origin = backendOrigin({ ROCKET_BACKEND_URL: process.argv[2] });
const checks = [];
const passed = (label) => {
  checks.push(label);
  console.log(`PASS ${label}`);
};
let cookie = "",
  connectionId = "",
  issued = false;

async function request(
  path,
  { method = "GET", body, privateSession = false } = {},
) {
  return fetch(origin + path, {
    method,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(method === "POST" ? { Origin: origin } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(privateSession ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json(response, expected = 200) {
  if (response.status !== expected)
    throw new Error(`Expected HTTP ${expected}; received ${response.status}.`);
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Expected JSON; received a page or interstitial.");
  return response.json();
}

try {
  const health = await json(await request("/api/health"));
  assert.equal(health.service, "rocket1000", "Unexpected backend service");
  assert.equal(health.protocol, 2, "Unexpected backend protocol");
  assert.match(health.instanceId, /^[0-9a-f-]{36}$/);
  passed("live HTTPS backend and migrated database respond");

  const page = await request("/mt5");
  assert.equal(page.status, 200, "MT5 page is unavailable");
  const html = await page.text();
  assert.ok(
    html.includes("Generate Connection") &&
      html.includes("Download Rocket1000 EA (.ex5)"),
    "MT5 controls are missing",
  );
  assert.ok(
    !/type="(?:email|password)"/.test(html),
    "Email/password fields are present",
  );
  passed("live MT5 page renders the connection and download controls");
  assert.equal(
    (await request("/api/mt5/connections")).status,
    401,
    "Anonymous account status must remain private",
  );
  passed("private connection status requires its browser session");

  const session = await request("/api/mt5/session", { method: "POST" });
  await json(session);
  const cookies = session.headers.getSetCookie();
  assert.ok(
    cookies.some(
      (c) =>
        c.startsWith("__Host-rocket1000_browser=") &&
        c.includes("HttpOnly") &&
        c.includes("Secure") &&
        c.includes("SameSite=Strict"),
    ),
    "Secure private cookie is missing",
  );
  cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  passed("automatic no-login workspace uses a secure HttpOnly cookie");

  const generated = await json(
    await request("/api/mt5/generate", {
      method: "POST",
      body: {},
      privateSession: true,
    }),
  );
  assert.equal(
    generated.serverUrl,
    origin,
    "Generated server URL does not match the live origin",
  );
  connectionId = generated.connectionId;
  assert.match(connectionId, /^[0-9a-f-]{36}$/);
  passed("Generate verifies the actual production HTTPS server");

  const download = await request("/api/mt5/download", {
    method: "POST",
    body: { connectionId, format: "package" },
    privateSession: true,
  });
  if (download.status !== 200)
    throw new Error(`EA download returned HTTP ${download.status}.`);
  issued = true;
  assert.ok(
    download.headers.get("content-type")?.includes("application/zip"),
    "EA download is not a ZIP",
  );
  assert.ok(
    download.headers.get("cache-control")?.includes("no-store"),
    "EA package must not be cached",
  );
  const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
  const binary = files["MQL5/Experts/ROCKET1000/ROCKET1000_EA.ex5"];
  assert.ok(binary?.length > 1024, "Compiled EA binary is missing");
  const { manifest } = await compiledArtifact();
  assert.equal(
    createHash("sha256").update(binary).digest("hex"),
    manifest.binarySha256,
    "Downloaded binary differs from the verified MetaEditor artifact",
  );
  const config = Object.fromEntries(
    strFromU8(files["MQL5/Files/ROCKET1000/rocket1000.config"])
      .trim()
      .split("\n")
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
  // Boolean checks avoid including credentials in an assertion's diagnostic output.
  assert.ok(config.backend_url === origin, "Bundled backend URL is incorrect");
  assert.ok(
    /^r1000\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(config.credential),
    "Bundled installation credential is invalid",
  );
  assert.ok(
    config.credential.split(".")[1] === config.installation_id,
    "Credential is not installation scoped",
  );
  assert.ok(
    Number(config.expires_at) * 1000 > Date.now(),
    "Credential is already expired",
  );
  assert.ok(
    files["INSTALL.txt"]?.length > 100,
    "Installation instructions are missing",
  );
  passed(
    "genuine compiled EA downloads with matching HTTPS URL and a private expiring credential",
  );

  const sourceDownload = await request("/api/mt5/download", {
    method: "POST",
    body: { connectionId },
    privateSession: true,
  });
  assert.equal(
    sourceDownload.status,
    200,
    "Default MetaEditor source download failed",
  );
  assert.ok(
    sourceDownload.headers.get("content-type")?.includes("text/x-mql5"),
    "Default download is not MQL5 source",
  );
  assert.ok(
    sourceDownload.headers.get("cache-control")?.includes("no-store"),
    "Private source must not be cached",
  );
  const source = await sourceDownload.text();
  const sourceCredential = source.match(/const string token="([^"]+)";/)?.[1];
  assert.ok(
    source.includes(`#property version   "${manifest.version}"`),
    "Source download has a stale EA version",
  );
  assert.ok(
    source.includes(`const string url="${origin}";`),
    "Source download has the wrong backend URL",
  );
  assert.ok(
    /^r1000\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(sourceCredential || ""),
    "Source credential is invalid",
  );
  assert.ok(
    !/FileOpen\s*\(|rocket1000\.config/.test(source),
    "Source still requires an external configuration file",
  );
  passed(
    "default download is the current private preconfigured MetaEditor source without a config-file dependency",
  );

  const state = await json(
    await request("/api/mt5/connections", { privateSession: true }),
  );
  const connection = state.connections.find((c) => c.id === connectionId);
  assert.ok(
    connection &&
      connection.status !== "Connected" &&
      connection.tradingEnabled === false,
    "A download must not simulate an MT5 connection or activate trading",
  );
  assert.ok(
    !JSON.stringify(state).includes(config.credential) &&
      !JSON.stringify(state).includes(sourceCredential),
    "Status response exposes the EA credential",
  );
  passed(
    "download alone leaves MT5 unconnected and trading disabled; status hides the token",
  );
} catch (error) {
  process.exitCode = 1;
  // Assertion diagnostics can contain private values. Print only the custom message.
  const message =
    error instanceof assert.AssertionError
      ? error.message.split("\n")[0]
      : error.message;
  console.error(`LIVE VERIFICATION INCOMPLETE: ${message}`);
} finally {
  if (issued && cookie && connectionId) {
    try {
      await json(
        await request("/api/mt5/revoke", {
          method: "POST",
          body: { connectionId },
          privateSession: true,
        }),
      );
      const state = await json(
        await request("/api/mt5/connections", { privateSession: true }),
      );
      assert.ok(
        state.connections.find((c) => c.id === connectionId)?.installation
          ?.revokedAt,
        "Test credential revocation is unverified",
      );
      passed("test EA credential revoked after verification");
    } catch {
      process.exitCode = 1;
      console.error("Test credential cleanup could not be verified.");
    }
  }
  console.log(
    `${checks.length} live provisioning checks passed. Actual MT5 communication, AI inference and order execution are separate acceptance steps.`,
  );
}
