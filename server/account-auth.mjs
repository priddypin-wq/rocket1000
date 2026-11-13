import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as webAuthnServer from "@simplewebauthn/server";
import { dashboardOrigin } from "./browser-session.mjs";
import { ApiError } from "./errors.mjs";

export const accountSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_users (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    created_at BIGINT NOT NULL, claimed_at BIGINT, legacy_claim_skipped_at BIGINT,
    FOREIGN KEY(workspace_id) REFERENCES rocket_workspaces(id))`,
  `CREATE TABLE IF NOT EXISTS rocket_account_passkeys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL,
    counter BIGINT NOT NULL, transports TEXT NOT NULL, created_at BIGINT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES rocket_users(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS rocket_account_passkeys_user ON rocket_account_passkeys(user_id)`,
  `CREATE TABLE IF NOT EXISTS rocket_account_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, authenticated_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL, absolute_expires_at BIGINT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES rocket_users(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS rocket_account_sessions_expiry ON rocket_account_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS rocket_account_challenges (
    token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, challenge TEXT NOT NULL,
    user_id TEXT, display_name TEXT, session_hash TEXT, expires_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS rocket_account_challenges_expiry ON rocket_account_challenges(expires_at)`,
];

const minute = 60_000;
const day = 24 * 60 * minute;
const idleSessionMs = 7 * day;
const absoluteSessionMs = 30 * day;
const challengeMs = 5 * minute;
const recentAuthMs = 10 * minute;
const permanentWorkspaceExpiry = Date.UTC(9999, 0, 1);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const credentialPattern = /^[A-Za-z0-9_-]{1,1400}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const forUpdate = (db) => (db.kind === "postgres" ? " FOR UPDATE" : "");
const userHandle = (id) => Buffer.from(id, "utf8");

export function accountAuthRequired(env = process.env) {
  return env.ROCKET_ACCOUNTS_REQUIRED === "1";
}

function passkeyError() {
  return new ApiError(
    401,
    "The passkey could not be verified. Try again.",
    "PASSKEY_REJECTED",
  );
}

function sessionError() {
  return new ApiError(
    401,
    "Sign in to your private ROCKET1000 account.",
    "ACCOUNT_SESSION_REQUIRED",
  );
}

function readCookie(req, name) {
  const prefix = `${name}=`;
  const pairs = (req.headers.get("cookie") || "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(prefix));
  const token = pairs.length === 1 ? pairs[0].slice(prefix.length) : "";
  return tokenPattern.test(token) ? token : null;
}

export function assertAccountOrigin(req, env = process.env) {
  const canonical = new URL(dashboardOrigin(env));
  const origin = canonical.origin;
  const incoming = new URL(req.url);
  // The Next.js dev server can serialize requests with a loopback alias in
  // req.url. The actual local Host must still match the configured RP.
  const loopbackAlias =
    env.NODE_ENV !== "production" &&
    ["127.0.0.1", "localhost"].includes(canonical.hostname) &&
    ["127.0.0.1", "localhost"].includes(incoming.hostname) &&
    incoming.protocol === canonical.protocol &&
    incoming.port === canonical.port &&
    req.headers.get("host") === canonical.host;
  if (incoming.origin !== origin && !loopbackAlias)
    throw new ApiError(
      403,
      "Open ROCKET1000 on its configured dashboard domain.",
      "ACCOUNT_ORIGIN_REJECTED",
    );
  if (
    req.method !== "GET" &&
    (req.headers.get("origin") !== origin ||
      req.headers.get("sec-fetch-site") === "cross-site")
  )
    throw new ApiError(
      403,
      "Request origin rejected.",
      "ACCOUNT_ORIGIN_REJECTED",
    );
}

export function accountSessions(
  db,
  { env = process.env, now = Date.now, webAuthn = webAuthnServer } = {},
) {
  const origin = dashboardOrigin(env);
  const rpID = new URL(origin).hostname;
  const secure = origin.startsWith("https:");
  const cookieName = (purpose) =>
    `${secure ? "__Host-" : ""}rocket1000_${purpose}`;
  const cookie = (purpose, token, milliseconds) =>
    `${cookieName(purpose)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(milliseconds / 1000))}${secure ? "; Secure" : ""}`;
  const clearCookie = (purpose) => cookie(purpose, "", 0);
  const tokenHash = (request, purpose) => {
    const token = readCookie(request, cookieName(purpose));
    return token ? hash(token) : null;
  };

  async function getSessionByHash(sessionHash, store = db, lock = false) {
    if (!sessionHash) return null;
    const [session] = await store.query(
      `SELECT s.user_id,s.authenticated_at,s.expires_at,s.absolute_expires_at,
              u.workspace_id,u.display_name,u.claimed_at,u.legacy_claim_skipped_at
         FROM rocket_account_sessions s JOIN rocket_users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>? AND s.absolute_expires_at>?${lock ? forUpdate(store) : ""}`,
      [sessionHash, now(), now()],
    );
    return session ? { ...session, sessionHash } : null;
  }

  function getSession(req, store = db, lock = false) {
    return getSessionByHash(tokenHash(req, "account"), store, lock);
  }

  function publicSession(session) {
    return {
      id: session.workspace_id,
      userId: session.user_id,
      displayName: session.display_name,
      email: null,
      role: session.user_id === env.ROCKET_OWNER_USER_ID ? "owner" : "customer",
      kind: "account",
      expiresAt: Number(session.expires_at),
      deviceRateKey: session.sessionHash,
    };
  }

  async function read(req) {
    const session = await getSession(req);
    return session ? publicSession(session) : null;
  }

  async function issueSession(tx, userId) {
    const token = newToken();
    const sessionHash = hash(token);
    const at = now();
    await tx.query(
      "INSERT INTO rocket_account_sessions(token_hash,user_id,authenticated_at,expires_at,absolute_expires_at) VALUES(?,?,?,?,?)",
      [sessionHash, userId, at, at + idleSessionMs, at + absoluteSessionMs],
    );
    return {
      sessionHash,
      sessionCookie: cookie("account", token, idleSessionMs),
    };
  }

  function requireRecent(session) {
    if (!session) throw sessionError();
    if (Number(session.authenticated_at) + recentAuthMs <= now())
      throw new ApiError(
        403,
        "Verify your passkey again to continue.",
        "ACCOUNT_REAUTHENTICATION_REQUIRED",
      );
  }

  async function workspaceEmpty(tx, id) {
    const [data] = await tx.query(
      `SELECT 1 FROM rocket_direct_connections WHERE user_id=?
       UNION ALL SELECT 1 FROM rocket_openai_credentials WHERE user_id=?
       UNION ALL SELECT 1 FROM rocket_ai_connection_checks WHERE user_id=?
       UNION ALL SELECT 1 FROM rocket_ai_usage WHERE user_id=?
       UNION ALL SELECT 1 FROM rocket_billing_checkouts WHERE workspace_id=? LIMIT 1`,
      [id, id, id, id, id],
    );
    return !data;
  }

  async function legacyWorkspace(req, store = db) {
    const legacyHash = tokenHash(req, "browser");
    if (!legacyHash) return null;
    const [legacy] = await store.query(
      `SELECT s.workspace_id FROM rocket_browser_sessions s
       JOIN rocket_workspaces w ON w.id=s.workspace_id
       WHERE s.token_hash=? AND s.expires_at>? AND w.expires_at>?`,
      [legacyHash, now(), now()],
    );
    return legacy ? { id: legacy.workspace_id, legacyHash } : null;
  }

  async function accountInfo(req, session) {
    const { userId, displayName, email, role, expiresAt } =
      publicSession(session);
    return {
      userId,
      displayName,
      email,
      role,
      expiresAt,
      legacyClaimAvailable: await legacyClaimAvailable(
        req,
        publicSession(session),
      ),
      reauthenticationRequired:
        Number(session.authenticated_at) + recentAuthMs <= now(),
    };
  }

  async function legacyClaimAvailable(req, account) {
    if (env.ROCKET_ALLOW_LEGACY_CLAIM !== "1" || account?.kind !== "account")
      return false;
    const legacy = await legacyWorkspace(req);
    if (!legacy || legacy.id === account.id) return false;
    const [candidate] = await db.query(
      `SELECT id FROM rocket_users WHERE id=? AND workspace_id=? AND claimed_at IS NULL AND legacy_claim_skipped_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM rocket_users owner WHERE owner.workspace_id=?)`,
      [account.userId, account.id, legacy.id],
    );
    return Boolean(candidate && (await workspaceEmpty(db, account.id)));
  }

  async function status(req) {
    const session = await getSession(req);
    if (!session) throw sessionError();
    const cookies = [];
    const at = now();
    const expiresAt = Math.min(
      at + idleSessionMs,
      Number(session.absolute_expires_at),
    );
    if (Number(session.expires_at) < expiresAt - day) {
      const [refreshed] = await db.query(
        "UPDATE rocket_account_sessions SET expires_at=? WHERE token_hash=? AND expires_at>? AND expires_at<? RETURNING expires_at",
        [expiresAt, session.sessionHash, at, expiresAt],
      );
      if (refreshed) {
        session.expires_at = refreshed.expires_at;
        cookies.push(
          cookie(
            "account",
            readCookie(req, cookieName("account")),
            expiresAt - at,
          ),
        );
      }
    }
    return {
      body: { ok: true, account: await accountInfo(req, session) },
      cookies,
    };
  }

  async function logout(req) {
    const sessionHash = tokenHash(req, "account");
    if (sessionHash)
      await db.query("DELETE FROM rocket_account_sessions WHERE token_hash=?", [
        sessionHash,
      ]);
    const challengeCookies = ["register", "login", "passkeys"];
    await db.query(
      "DELETE FROM rocket_account_challenges WHERE token_hash IN (?,?,?)",
      challengeCookies.map((purpose) => tokenHash(req, purpose)),
    );
    return {
      body: { ok: true },
      cookies: [clearCookie("account"), ...challengeCookies.map(clearCookie)],
    };
  }

  async function options(req, purpose, input) {
    const session = await getSession(req);
    if (
      purpose === "register" &&
      env.ROCKET_ACCOUNT_SIGNUP_ENABLED !== "1" &&
      !(env.ROCKET_ALLOW_LEGACY_CLAIM === "1" && (await legacyWorkspace(req)))
    )
      throw new ApiError(
        403,
        "New account registration is currently unavailable.",
        "ACCOUNT_SIGNUP_DISABLED",
      );
    if (purpose === "register" && session)
      throw new ApiError(
        409,
        "Sign out before creating another account.",
        "ACCOUNT_ALREADY_SIGNED_IN",
      );
    if (purpose === "passkeys") requireRecent(session);
    const userId =
      purpose === "register" ? randomUUID() : (session?.user_id ?? null);
    const displayName =
      purpose === "register"
        ? (typeof input.name === "string"
            ? input.name
                .trim()
                .replace(/\p{Cc}/gu, "")
                .slice(0, 64)
            : "") || "ROCKET1000 account"
        : (session?.display_name ?? null);
    let passkeyOptions;
    if (purpose === "login") {
      passkeyOptions = await webAuthn.generateAuthenticationOptions({
        rpID,
        userVerification: "required",
        timeout: challengeMs,
      });
    } else {
      const credentials =
        purpose === "passkeys"
          ? await db.query(
              "SELECT id,transports FROM rocket_account_passkeys WHERE user_id=?",
              [userId],
            )
          : [];
      if (credentials.length >= 10)
        throw new ApiError(
          409,
          "This account already has ten passkeys.",
          "ACCOUNT_PASSKEY_LIMIT",
        );
      passkeyOptions = await webAuthn.generateRegistrationOptions({
        rpName: "ROCKET1000",
        rpID,
        userID: userHandle(userId),
        userName: userId,
        userDisplayName: displayName,
        attestationType: "none",
        timeout: challengeMs,
        excludeCredentials: credentials.map(({ id, transports }) => ({
          id,
          transports: JSON.parse(transports),
        })),
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
      });
    }
    const token = newToken();
    const at = now();
    await db.query("DELETE FROM rocket_account_sessions WHERE expires_at<=?", [
      at,
    ]);
    await db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM rocket_account_challenges WHERE expires_at<=? OR token_hash=?",
        [at, tokenHash(req, purpose)],
      );
      await tx.query(
        "INSERT INTO rocket_account_challenges(token_hash,purpose,challenge,user_id,display_name,session_hash,expires_at) VALUES(?,?,?,?,?,?,?)",
        [
          hash(token),
          purpose,
          passkeyOptions.challenge,
          userId,
          displayName,
          session?.sessionHash ?? null,
          at + challengeMs,
        ],
      );
    });
    return {
      body: { options: passkeyOptions },
      cookies: [cookie(purpose, token, challengeMs)],
    };
  }

  async function consumeChallenge(req, purpose) {
    const challengeHash = tokenHash(req, purpose);
    if (!challengeHash) throw passkeyError();
    const [challenge] = await db.query(
      "DELETE FROM rocket_account_challenges WHERE token_hash=? AND purpose=? AND expires_at>? RETURNING challenge,user_id,display_name,session_hash",
      [challengeHash, purpose, now()],
    );
    if (
      !challenge ||
      (challenge.session_hash !== tokenHash(req, "account") &&
        (challenge.session_hash || (await getSession(req))))
    )
      throw passkeyError();
    return challenge;
  }

  function validateResponse(response) {
    if (
      typeof response?.id !== "string" ||
      !credentialPattern.test(response.id)
    )
      throw passkeyError();
    try {
      const data = JSON.parse(
        Buffer.from(response.response.clientDataJSON, "base64url").toString(
          "utf8",
        ),
      );
      if (data.crossOrigin === true || data.topOrigin) throw passkeyError();
    } catch {
      throw passkeyError();
    }
  }

  async function verifyRegistration(req, purpose, challenge, response) {
    let result;
    try {
      result = await webAuthn.verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      throw passkeyError();
    }
    if (!result.verified) throw passkeyError();
    const { id, publicKey, counter, transports } =
      result.registrationInfo.credential;
    const userId = challenge.user_id;
    return db.transaction(async (tx) => {
      if (purpose === "register") {
        if (await getSession(req, tx)) throw passkeyError();
        const workspaceId = randomUUID();
        await tx.query(
          "INSERT INTO rocket_workspaces(id,created_at,expires_at) VALUES(?,?,?)",
          [workspaceId, now(), permanentWorkspaceExpiry],
        );
        await tx.query(
          "INSERT INTO rocket_users(id,workspace_id,display_name,created_at) VALUES(?,?,?,?)",
          [userId, workspaceId, challenge.display_name, now()],
        );
      } else {
        const session = await getSession(req, tx, true);
        requireRecent(session);
        if (
          session.user_id !== userId ||
          session.sessionHash !== challenge.session_hash
        )
          throw passkeyError();
        const [count] = await tx.query(
          "SELECT COUNT(*) AS total FROM rocket_account_passkeys WHERE user_id=?",
          [userId],
        );
        if (Number(count.total) >= 10)
          throw new ApiError(
            409,
            "This account already has ten passkeys.",
            "ACCOUNT_PASSKEY_LIMIT",
          );
      }
      const [added] = await tx.query(
        "INSERT INTO rocket_account_passkeys(id,user_id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id",
        [
          id,
          userId,
          Buffer.from(publicKey).toString("base64url"),
          counter,
          JSON.stringify(transports ?? []),
          now(),
        ],
      );
      if (!added) throw passkeyError();
      if (purpose === "passkeys") return null;
      return issueSession(tx, userId);
    });
  }

  async function verifyLogin(req, challenge, response) {
    return db.transaction(async (tx) => {
      const previous = await getSession(req, tx, true);
      if ((previous?.sessionHash ?? null) !== challenge.session_hash)
        throw passkeyError();
      const [stored] = await tx.query(
        `SELECT id,user_id,public_key,counter,transports FROM rocket_account_passkeys WHERE id=?${forUpdate(tx)}`,
        [response.id],
      );
      if (
        !stored ||
        (challenge.user_id && challenge.user_id !== stored.user_id) ||
        response.response.userHandle !==
          userHandle(stored.user_id).toString("base64url")
      )
        throw passkeyError();
      let result;
      try {
        result = await webAuthn.verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: stored.id,
            counter: Number(stored.counter),
            publicKey: Buffer.from(stored.public_key, "base64url"),
            transports: JSON.parse(stored.transports),
          },
        });
      } catch {
        throw passkeyError();
      }
      if (!result.verified) throw passkeyError();
      await tx.query(
        "UPDATE rocket_account_passkeys SET counter=? WHERE id=?",
        [result.authenticationInfo.newCounter, stored.id],
      );
      if (previous)
        await tx.query(
          "DELETE FROM rocket_account_sessions WHERE token_hash=?",
          [previous.sessionHash],
        );
      return issueSession(tx, stored.user_id);
    });
  }

  async function verify(req, purpose, response) {
    const challenge = await consumeChallenge(req, purpose);
    validateResponse(response);
    const result =
      purpose === "login"
        ? await verifyLogin(req, challenge, response)
        : await verifyRegistration(req, purpose, challenge, response);
    const cookies = [clearCookie(purpose)];
    if (result) cookies.push(result.sessionCookie);
    const session = result
      ? await getSessionByHash(result.sessionHash)
      : await getSession(req);
    if (!session) throw sessionError();
    return {
      body: { ok: true, account: await accountInfo(req, session) },
      cookies,
    };
  }

  async function claim(req, confirm) {
    if (env.ROCKET_ALLOW_LEGACY_CLAIM !== "1")
      throw new ApiError(
        403,
        "Browser workspace linking is disabled.",
        "LEGACY_CLAIM_DISABLED",
      );
    if (confirm !== true)
      throw new ApiError(
        400,
        "Confirm that the workspace in this browser belongs to you.",
        "LEGACY_CLAIM_CONFIRMATION_REQUIRED",
      );
    const session = await db.transaction(async (tx) => {
      const account = await getSession(req, tx, true);
      requireRecent(account);
      if (account.claimed_at || account.legacy_claim_skipped_at)
        throw new ApiError(
          409,
          "This account already linked a browser workspace.",
          "LEGACY_ALREADY_CLAIMED",
        );
      const legacy = await legacyWorkspace(req, tx);
      if (!legacy || legacy.id === account.workspace_id)
        throw new ApiError(
          403,
          "Open the browser with your original private connection to link it.",
          "LEGACY_OWNERSHIP_REQUIRED",
        );
      await tx.query(
        `SELECT id FROM rocket_workspaces WHERE id IN (?,?) ORDER BY id${forUpdate(tx)}`,
        [legacy.id, account.workspace_id],
      );
      const [owner] = await tx.query(
        "SELECT id FROM rocket_users WHERE workspace_id=?",
        [legacy.id],
      );
      if (owner || !(await workspaceEmpty(tx, account.workspace_id)))
        throw new ApiError(
          409,
          "Linking requires a new account with no private trading data.",
          "LEGACY_WORKSPACE_CONFLICT",
        );
      const [proof] = await tx.query(
        "DELETE FROM rocket_browser_sessions WHERE token_hash=? AND workspace_id=? AND expires_at>? RETURNING workspace_id",
        [legacy.legacyHash, legacy.id, now()],
      );
      if (!proof)
        throw new ApiError(
          403,
          "The original browser session has expired.",
          "LEGACY_OWNERSHIP_REQUIRED",
        );
      const at = now();
      await tx.query("UPDATE rocket_workspaces SET expires_at=? WHERE id=?", [
        permanentWorkspaceExpiry,
        legacy.id,
      ]);
      await tx.query(
        "UPDATE rocket_users SET workspace_id=?,claimed_at=? WHERE id=?",
        [legacy.id, at, account.user_id],
      );
      await tx.query("DELETE FROM rocket_workspaces WHERE id=?", [
        account.workspace_id,
      ]);
      return { ...account, workspace_id: legacy.id, claimed_at: at };
    });
    return {
      body: { ok: true, account: await accountInfo(req, session) },
      cookies: [clearCookie("browser")],
    };
  }

  async function skipClaim(req) {
    if (env.ROCKET_ALLOW_LEGACY_CLAIM !== "1")
      throw new ApiError(
        403,
        "Browser workspace linking is disabled.",
        "LEGACY_CLAIM_DISABLED",
      );
    const session = await db.transaction(async (tx) => {
      const account = await getSession(req, tx, true);
      requireRecent(account);
      await tx.query(
        "UPDATE rocket_users SET legacy_claim_skipped_at=? WHERE id=? AND claimed_at IS NULL AND legacy_claim_skipped_at IS NULL",
        [now(), account.user_id],
      );
      return account;
    });
    return {
      body: { ok: true, account: await accountInfo(req, session) },
      cookies: [],
    };
  }

  return {
    read,
    status,
    logout,
    options,
    verify,
    claim,
    skipClaim,
    legacyClaimAvailable,
  };
}
