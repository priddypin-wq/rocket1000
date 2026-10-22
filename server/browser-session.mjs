import { randomBytes, randomUUID, createHash } from "node:crypto";
import { ApiError } from "./provisioning.mjs";
export const BROWSER_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function dashboardOrigin(env = process.env) {
  try {
    const u = new URL(env.ROCKET_DASHBOARD_URL);
    if (
      u.origin !== u.href.replace(/\/$/, "") ||
      u.username ||
      u.password ||
      !["https:", "http:"].includes(u.protocol)
    )
      throw Error();
    if (
      u.protocol !== "https:" &&
      (env.NODE_ENV === "production" ||
        !["localhost", "127.0.0.1"].includes(u.hostname))
    )
      throw Error();
    return u.origin;
  } catch {
    throw new ApiError(
      503,
      "The dashboard origin is not configured.",
      "DASHBOARD_NOT_CONFIGURED",
    );
  }
}
function cookieName() {
  return dashboardOrigin().startsWith("https:")
    ? "__Host-rocket1000_browser"
    : "rocket1000_browser";
}
export function browserSessions(db, { now = Date.now } = {}) {
  async function read(request) {
    const name = cookieName();
    const pairs = (request.headers.get("cookie") || "")
      .split(";")
      .map((s) => s.trim());
    const pair = pairs.find((s) => s.startsWith(`${name}=`));
    const token = pair?.slice(name.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [session] = await db.query(
      "SELECT workspace_id,expires_at FROM rocket_browser_sessions WHERE token_hash=?",
      [hash(token)],
    );
    if (!session || Number(session.expires_at) <= now()) return null;
    return { id: session.workspace_id, expiresAt: Number(session.expires_at) };
  }
  async function create() {
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const expiresAt = now() + BROWSER_LIFETIME_MS;
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO rocket_workspaces(id,created_at,expires_at) VALUES(?,?,?)",
        [id, now(), expiresAt],
      );
      await tx.query(
        "INSERT INTO rocket_browser_sessions(token_hash,workspace_id,created_at,expires_at) VALUES(?,?,?,?)",
        [hash(token), id, now(), expiresAt],
      );
    });
    const secure = dashboardOrigin().startsWith("https:");
    return {
      id,
      expiresAt,
      cookie: `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${BROWSER_LIFETIME_MS / 1000}${secure ? "; Secure" : ""}`,
    };
  }
  return { read, create };
}
