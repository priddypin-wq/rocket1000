import { browserSessions, dashboardOrigin } from "./browser-session.mjs";
import { getDatabase } from "./database.mjs";
import { ApiError, provisioningService } from "./provisioning.mjs";
import { automationService } from "./automation.mjs";
export const responseHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export async function jsonInput(req, limit = 8192) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new ApiError(415, "JSON content type required");
  // Bound chunked bodies too; Content-Length alone is not a reliable limit.
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "Missing request body");
  let bytes = 0;
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel();
      throw new ApiError(413, "Request too large");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
}
export function assertOrigin(req) {
  const expected = dashboardOrigin();
  if (
    req.headers.get("origin") !== expected ||
    req.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new ApiError(403, "Request origin rejected");
}
export async function dashboardRequest(req, fn) {
  return handle(async () => {
    const session = await browserSessions(getDatabase()).read(req);
    if (!session)
      throw new ApiError(
        401,
        "Initialize this browser's private connection.",
        "BROWSER_SESSION_REQUIRED",
      );
    if (req.method !== "GET") assertOrigin(req);
    const service = provisioningService(getDatabase());
    await service.rateLimit(`dashboard:${session.id}`, 120);
    return fn(service, session.id);
  });
}
export async function initializeBrowser(req) {
  return handle(async () => {
    assertOrigin(req);
    const db = getDatabase();
    const sessions = browserSessions(db);
    const service = provisioningService(db);
    const existing = await sessions.read(req);
    if (existing) return { ok: true };
    await service.rateLimit("browser-session-create", 60);
    const session = await sessions.create();
    return Response.json(
      { ok: true },
      { headers: { ...responseHeaders, "Set-Cookie": session.cookie } },
    );
  });
}
export async function handle(fn) {
  try {
    const data = await fn();
    return data instanceof Response
      ? data
      : Response.json(data, { headers: responseHeaders });
  } catch (error) {
    const known = error instanceof ApiError;
    // Do not log request bodies, cookies, bearer credentials, ZIPs, or database URLs.
    if (!known) console.error("ROCKET1000 backend request failed");
    return Response.json(
      {
        error: known
          ? error.message
          : "Backend unavailable. Check server configuration and migrations.",
        code: known ? error.code : "BACKEND_UNAVAILABLE",
      },
      { status: known ? error.status : 503, headers: responseHeaders },
    );
  }
}
export async function eaRequest(req, register, options = {}) {
  return handle(async () => {
    const header = req.headers.get("authorization") || "";
    if (!header.startsWith("Bearer "))
      throw new ApiError(
        401,
        "EA credential required",
        "AUTHENTICATION_FAILED",
      );
    const token = header.slice(7);
    const service = provisioningService(getDatabase());
    // Fixed bounded keys: do not allow untrusted random tokens to grow the limiter table indefinitely.
    await service.rateLimit("ea-ingress", 3000);
    const result = await service.telemetry(
      token,
      await jsonInput(req, 196608),
      register,
      options,
    );
    if (result.wakeAutomation && typeof options.schedule === "function")
      options.schedule(() =>
        automationService(getDatabase()).cycle(result.installationId),
      );
    delete result.wakeAutomation;
    return result;
  });
}
