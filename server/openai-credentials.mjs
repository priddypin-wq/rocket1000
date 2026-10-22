import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { ApiError } from "./errors.mjs";
import { aiConnectionService } from "./ai-connection.mjs";
import { configuredModel } from "./ai-provider.mjs";

// Only authenticated workspace identities address this table. The separately
// managed encryption secret never enters the database, payloads or public EA.
export const openaiCredentialSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_openai_credentials (user_id TEXT PRIMARY KEY,ciphertext TEXT,nonce TEXT,tag TEXT,version INTEGER NOT NULL,model TEXT NOT NULL,revision TEXT NOT NULL,updated_at BIGINT NOT NULL,removed_at BIGINT,FOREIGN KEY(user_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE)`,
];
const VERSION = 1;
const encryptionError = () =>
  new ApiError(
    503,
    "OpenAI key storage is unavailable. Configure the separate server encryption secret.",
    "OPENAI_ENCRYPTION_UNAVAILABLE",
  );
function encryptionKey(env) {
  const text = env.ROCKET_OPENAI_ENCRYPTION_KEY;
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(text))
    throw encryptionError();
  const key = Buffer.from(text, "base64");
  if (key.length !== 32 || key.toString("base64") !== text)
    throw encryptionError();
  return key;
}
function encryptionReady(env) {
  try {
    encryptionKey(env).fill(0);
    return true;
  } catch {
    return false;
  }
}
function aad(uid) {
  return Buffer.from(`ROCKET1000:OPENAI:${VERSION}:${uid}`, "utf8");
}
function seal(uid, value, env) {
  const key = encryptionKey(env);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(uid));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}
function unseal(uid, row, env) {
  const key = encryptionKey(env);
  try {
    if (
      Number(row.version) !== VERSION ||
      Buffer.from(row.nonce, "base64").length !== 12 ||
      Buffer.from(row.tag, "base64").length !== 16
    )
      throw Error();
    const cipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(row.nonce, "base64"),
    );
    cipher.setAAD(aad(uid));
    cipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return Buffer.concat([
      cipher.update(Buffer.from(row.ciphertext, "base64")),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw encryptionError();
  } finally {
    key.fill(0);
  }
}
function cleanKey(key) {
  if (typeof key !== "string" || !/^sk-[A-Za-z0-9_-]{17,509}$/.test(key))
    throw new ApiError(
      400,
      "Enter a valid OpenAI API key. The saved key is never displayed.",
      "OPENAI_KEY_INVALID",
    );
  return key;
}

// This only revokes future work. A broker request already in flight is reconciled
// through its existing uncertain/ack state; a key change cannot invent a close.
async function revokeExistingWork(uid, tx) {
  await tx.query(
    "UPDATE rocket_direct_connections SET stopped=1 WHERE user_id=?",
    [uid],
  );
  await tx.query(
    "DELETE FROM rocket_trade_policy WHERE connection_id IN (SELECT id FROM rocket_direct_connections WHERE user_id=?)",
    [uid],
  );
  await tx.query(
    "UPDATE rocket_automation SET state='stopped',run_id=?,lease_until=0 WHERE connection_id IN (SELECT id FROM rocket_direct_connections WHERE user_id=?)",
    [randomUUID(), uid],
  );
  await tx.query(
    "UPDATE rocket_trade_commands SET status='cancelled' WHERE status IN ('queued','claimed') AND connection_id IN (SELECT id FROM rocket_direct_connections WHERE user_id=?)",
    [uid],
  );
  await tx.query(
    "UPDATE rocket_analyses SET status='cancelled' WHERE status IN ('pending','running') AND connection_id IN (SELECT id FROM rocket_direct_connections WHERE user_id=?)",
    [uid],
  );
  await tx.query(
    "DELETE FROM rocket_order_previews WHERE connection_id IN (SELECT id FROM rocket_direct_connections WHERE user_id=?)",
    [uid],
  );
  await tx.query("DELETE FROM rocket_ai_connection_checks WHERE user_id=?", [
    uid,
  ]);
}

/**
 * @param {*} db
 * @param {{env?: NodeJS.ProcessEnv, now?: ()=>number, onChange?: (uid:string, tx:*)=>Promise<void>, responder?: typeof import('./ai-provider.mjs').createAiResponse, beforeRequest?: (uid:string, request:*)=>Promise<*>}} [options]
 */
export function openaiCredentialService(
  db,
  {
    env = process.env,
    now = Date.now,
    onChange,
    responder,
    beforeRequest,
  } = {},
) {
  async function workspace(uid, tx = db) {
    const [row] = await tx.query(
      `SELECT id FROM rocket_workspaces WHERE id=? AND expires_at>?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
      [uid, now()],
    );
    if (!row)
      throw new ApiError(
        401,
        "A private workspace session is required.",
        "BROWSER_SESSION_REQUIRED",
      );
  }
  async function record(uid) {
    await workspace(uid);
    const [row] = await db.query(
      "SELECT * FROM rocket_openai_credentials WHERE user_id=?",
      [uid],
    );
    return row;
  }
  async function environment(uid) {
    const row = await record(uid);
    const key = row
      ? row.removed_at
        ? ""
        : unseal(uid, row, env)
      : typeof env.OPENAI_API_KEY === "string"
        ? env.OPENAI_API_KEY.trim()
        : "";
    // An explicit Remove is a tombstone: the environment key cannot silently
    // reactivate this workspace. Gateway credentials are never a paid fallback.
    return {
      ...env,
      OPENAI_API_KEY: key,
      OPENAI_MODEL: row?.model || configuredModel(env),
      ROCKET_OPENAI_DIRECT_ONLY: "1",
      AI_GATEWAY_API_KEY: "",
      VERCEL_OIDC_TOKEN: "",
    };
  }
  const connection = aiConnectionService(db, {
    now,
    env,
    responder,
    resolveEnvironment: environment,
    beforeRequest,
  });
  async function status(uid) {
    const row = await record(uid);
    const stored = !!row && !row.removed_at;
    const configured =
      stored ||
      (!row &&
        typeof env.OPENAI_API_KEY === "string" &&
        !!env.OPENAI_API_KEY.trim());
    const ready = encryptionReady(env);
    let check;
    try {
      check = await connection.status(uid);
    } catch (e) {
      if (
        !(e instanceof ApiError) ||
        e.code !== "OPENAI_ENCRYPTION_UNAVAILABLE"
      )
        throw e;
      check = {
        state: "error",
        connected: false,
        errorCode: e.code,
        error: e.message,
      };
    }
    return {
      configured,
      stored,
      source: stored ? "saved" : configured ? "environment" : "none",
      encryptionReady: ready,
      model: row?.model || configuredModel(env),
      revision: row?.revision || null,
      updatedAt: row ? Number(row.updated_at) : null,
      connection: check,
    };
  }
  async function save(uid, input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["key", "model"].includes(k))
    )
      throw new ApiError(
        400,
        "Only an API key and optional model are accepted.",
        "OPENAI_KEY_INVALID",
      );
    const key = cleanKey(input.key);
    if (
      input.model !== undefined &&
      (typeof input.model !== "string" ||
        !/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(input.model))
    )
      throw new ApiError(
        400,
        "Choose a valid configured OpenAI reasoning model.",
        "AI_MODEL_INVALID",
      );
    // The selected model is a proposal until a real Responses probe succeeds.
    const model = configuredModel(
      input.model === undefined ? env : { OPENAI_MODEL: input.model },
    );
    const encrypted = seal(uid, key, env);
    await db.transaction(async (tx) => {
      await workspace(uid, tx);
      await tx.query(
        "INSERT INTO rocket_openai_credentials(user_id,ciphertext,nonce,tag,version,model,revision,updated_at,removed_at) VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,tag=excluded.tag,version=excluded.version,model=excluded.model,revision=excluded.revision,updated_at=excluded.updated_at,removed_at=NULL",
        [
          uid,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          VERSION,
          model,
          randomUUID(),
          now(),
        ],
      );
      await revokeExistingWork(uid, tx);
      await onChange?.(uid, tx);
    });
    return status(uid);
  }
  async function remove(uid) {
    await db.transaction(async (tx) => {
      await workspace(uid, tx);
      await tx.query(
        "INSERT INTO rocket_openai_credentials(user_id,ciphertext,nonce,tag,version,model,revision,updated_at,removed_at) VALUES(?,NULL,NULL,NULL,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET ciphertext=NULL,nonce=NULL,tag=NULL,revision=excluded.revision,updated_at=excluded.updated_at,removed_at=excluded.removed_at",
        [uid, VERSION, configuredModel(env), randomUUID(), now(), now()],
      );
      await revokeExistingWork(uid, tx);
      await onChange?.(uid, tx);
    });
    return status(uid);
  }
  return {
    status,
    environment,
    save,
    remove,
    test: (uid) => connection.test(uid),
  };
}

export function assertOpenaiHttps(request) {
  if (new URL(request.url).protocol !== "https:")
    throw new ApiError(
      400,
      "OpenAI key management requires HTTPS.",
      "OPENAI_HTTPS_REQUIRED",
    );
}
