import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { authenticator } from "./webauthn-fixture.mjs";
import {
  accountSessions,
  assertAccountOrigin,
} from "../server/account-auth.mjs";
import { openDatabase, migrateConnections } from "../server/database.mjs";

const origin = "https://rocket1000.example";
const env = {
  ROCKET_DASHBOARD_URL: origin,
  ROCKET_ALLOW_LEGACY_CLAIM: "1",
  ROCKET_ACCOUNT_SIGNUP_ENABLED: "1",
};
const hash = (value) => createHash("sha256").update(value).digest();
const serialize = (value) => Buffer.from(value).toString("base64url");
const cookieValue = (result, purpose) =>
  result.cookies
    .find((entry) => entry.startsWith(`__Host-rocket1000_${purpose}=`))
    ?.split(";")[0];

function request(...cookies) {
  return new Request(`${origin}/api/account/session`, {
    headers: { cookie: cookies.filter(Boolean).join("; ") },
  });
}

async function setup(t) {
  const db = openDatabase({ filename: ":memory:" });
  t.after(() => db.close());
  await migrateConnections(db);
  let now = Date.parse("2026-11-13T10:00:00Z");
  const config = { ...env };
  const accounts = accountSessions(db, { env: config, now: () => now });
  async function enroll(device = authenticator(origin), legacyCookie) {
    const creation = await accounts.options(request(legacyCookie), "register", {
      name: "Test account",
    });
    const response = device.register(creation.body.options);
    const result = await accounts.verify(
      request(cookieValue(creation, "register"), legacyCookie),
      "register",
      response,
    );
    const accountCookie = cookieValue(result, "account");
    return {
      ...result.body.account,
      accountCookie,
      device,
      workspace: (await accounts.read(request(accountCookie))).id,
    };
  }
  async function legacy() {
    const token = serialize(randomBytes(32));
    const id = `old-workspace-${token}`;
    const tokenHash = hash(token).toString("hex");
    const expiresAt = now + 60_000;
    await db.query(
      "INSERT INTO rocket_workspaces(id,created_at,expires_at) VALUES(?,?,?)",
      [id, now, expiresAt],
    );
    await db.query(
      "INSERT INTO rocket_browser_sessions(token_hash,workspace_id,created_at,expires_at) VALUES(?,?,?,?)",
      [tokenHash, id, now, expiresAt],
    );
    return { id, cookie: `__Host-rocket1000_browser=${token}` };
  }
  return {
    accounts,
    db,
    config,
    enroll,
    legacy,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("WebAuthn sign-in on a second device resolves to the same workspace, isolated from a second user", async (t) => {
  const { accounts, db, enroll, config } = await setup(t);
  const desktop = await enroll();
  const mobileChallenge = await accounts.options(request(), "login", {});
  const mobile = await accounts.verify(
    request(cookieValue(mobileChallenge, "login")),
    "login",
    desktop.device.login(mobileChallenge.body.options),
  );
  const mobileCookie = cookieValue(mobile, "account");
  assert.notEqual(mobileCookie, desktop.accountCookie);
  assert.equal(
    (await accounts.read(request(mobileCookie))).id,
    desktop.workspace,
  );
  assert.equal(mobile.body.account.userId, desktop.userId);
  assert.equal(mobile.body.account.role, "customer");
  assert.equal(mobile.body.account.id, undefined);
  assert.match(
    mobile.cookies.at(-1),
    /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/,
  );
  const [stored] = await db.query(
    "SELECT token_hash FROM rocket_account_sessions WHERE user_id=?",
    [desktop.userId],
  );
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.equal(mobileCookie.includes(stored.token_hash), false);
  const stranger = await enroll();
  assert.notEqual(stranger.workspace, desktop.workspace);
  assert.notEqual(stranger.userId, desktop.userId);
  config.ROCKET_OWNER_USER_ID = desktop.userId;
  assert.equal((await accounts.read(request(mobileCookie))).role, "owner");
  assert.equal(
    (await accounts.read(request(stranger.accountCookie))).role,
    "customer",
  );
  await accounts.logout(request(mobileCookie));
  assert.equal(await accounts.read(request(mobileCookie)), null);
  assert.equal(
    (await accounts.read(request(desktop.accountCookie))).id,
    desktop.workspace,
  );
});

test("Passkey challenges cannot be replayed, moved to another browser, used on another origin or bypass user verification", async (t) => {
  const { accounts, enroll, advance } = await setup(t);
  const desktop = await enroll();
  const challenge = await accounts.options(request(), "login", {});
  const challengeCookie = cookieValue(challenge, "login");
  const signed = desktop.device.login(challenge.body.options);
  await assert.rejects(accounts.verify(request(), "login", signed), {
    code: "PASSKEY_REJECTED",
  });
  await accounts.verify(request(challengeCookie), "login", signed);
  await assert.rejects(
    accounts.verify(request(challengeCookie), "login", signed),
    { code: "PASSKEY_REJECTED" },
  );
  for (const invalid of [
    { clientOrigin: "https://other.example" },
    { userVerified: false },
  ]) {
    const options = await accounts.options(request(), "login", {});
    await assert.rejects(
      accounts.verify(
        request(cookieValue(options, "login")),
        "login",
        desktop.device.login(options.body.options, invalid),
      ),
      { code: "PASSKEY_REJECTED" },
    );
  }
  const expired = await accounts.options(request(), "login", {});
  advance(5 * 60_000);
  await assert.rejects(
    accounts.verify(
      request(cookieValue(expired, "login")),
      "login",
      desktop.device.login(expired.body.options),
    ),
    { code: "PASSKEY_REJECTED" },
  );
  assert.throws(
    () =>
      assertAccountOrigin(
        new Request("https://other.example/api/account/session"),
        env,
      ),
    { code: "ACCOUNT_ORIGIN_REJECTED" },
  );
  assert.throws(
    () =>
      assertAccountOrigin(
        new Request(`${origin}/api/account/claim`, {
          method: "POST",
          headers: { origin: "https://other.example" },
        }),
        env,
      ),
    { code: "ACCOUNT_ORIGIN_REJECTED" },
  );
});

test("Passkey reauthentication rotates the device session and permits another passkey for the same identity", async (t) => {
  const { accounts, enroll, advance } = await setup(t);
  const desktop = await enroll();
  advance(10 * 60_000);
  await assert.rejects(
    accounts.options(request(desktop.accountCookie), "passkeys", {}),
    { code: "ACCOUNT_REAUTHENTICATION_REQUIRED" },
  );
  const signedIn = await accounts.options(
    request(desktop.accountCookie),
    "login",
    {},
  );
  const reauth = await accounts.verify(
    request(desktop.accountCookie, cookieValue(signedIn, "login")),
    "login",
    desktop.device.login(signedIn.body.options),
  );
  const reauthenticatedCookie = cookieValue(reauth, "account");
  assert.equal(await accounts.read(request(desktop.accountCookie)), null);
  const add = await accounts.options(
    request(reauthenticatedCookie),
    "passkeys",
    {},
  );
  const phone = authenticator(origin);
  await accounts.verify(
    request(reauthenticatedCookie, cookieValue(add, "passkeys")),
    "passkeys",
    phone.register(add.body.options),
  );
  const phoneChallenge = await accounts.options(request(), "login", {});
  const phoneLogin = await accounts.verify(
    request(cookieValue(phoneChallenge, "login")),
    "login",
    phone.login(phoneChallenge.body.options),
  );
  assert.equal(
    (await accounts.read(request(cookieValue(phoneLogin, "account")))).id,
    desktop.workspace,
  );
});

test("Legacy claim requires two independent proofs and preserves MT5 and OpenAI storage in place", async (t) => {
  const { accounts, db, enroll, legacy } = await setup(t);
  const old = await legacy();
  const current = await enroll(undefined, old.cookie);
  assert.equal(current.legacyClaimAvailable, true);
  await db.query(
    "INSERT INTO rocket_direct_connections(id,user_id,label,created_at) VALUES(?,?,?,?)",
    ["old-connection", old.id, "Existing connection", 1],
  );
  await db.query(
    "INSERT INTO rocket_direct_installations(id,connection_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
    [
      "old-installation",
      "old-connection",
      "old-installation-token-hash",
      1,
      100,
    ],
  );
  await db.query(
    "INSERT INTO rocket_openai_credentials(user_id,ciphertext,version,model,revision,updated_at) VALUES(?,?,?,?,?,?)",
    [old.id, "stored-ciphertext", 1, "existing-model", "existing-revision", 1],
  );
  await assert.rejects(accounts.claim(request(old.cookie), true), {
    code: "ACCOUNT_SESSION_REQUIRED",
  });
  await assert.rejects(accounts.claim(request(current.accountCookie), true), {
    code: "LEGACY_OWNERSHIP_REQUIRED",
  });
  await assert.rejects(
    accounts.claim(request(current.accountCookie, old.cookie), false),
    { code: "LEGACY_CLAIM_CONFIRMATION_REQUIRED" },
  );
  const claimed = await accounts.claim(
    request(current.accountCookie, old.cookie),
    true,
  );
  assert.equal(claimed.body.account.legacyClaimAvailable, false);
  assert.equal(
    (await accounts.read(request(current.accountCookie))).id,
    old.id,
  );
  assert.equal(
    (
      await db.query(
        "SELECT user_id FROM rocket_direct_connections WHERE id=?",
        ["old-connection"],
      )
    )[0].user_id,
    old.id,
  );
  assert.equal(
    (
      await db.query(
        "SELECT token_hash FROM rocket_direct_installations WHERE id=?",
        ["old-installation"],
      )
    )[0].token_hash,
    "old-installation-token-hash",
  );
  assert.equal(
    (
      await db.query(
        "SELECT ciphertext FROM rocket_openai_credentials WHERE user_id=?",
        [old.id],
      )
    )[0].ciphertext,
    "stored-ciphertext",
  );
  assert.equal(
    (
      await db.query("SELECT id FROM rocket_workspaces WHERE id=?", [
        current.workspace,
      ])
    ).length,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT workspace_id FROM rocket_browser_sessions WHERE workspace_id=?",
        [old.id],
      )
    ).length,
    0,
  );
  const stranger = await enroll();
  await assert.rejects(
    accounts.claim(request(stranger.accountCookie, old.cookie), true),
    { code: "LEGACY_OWNERSHIP_REQUIRED" },
  );
});

test("Concurrent claims have one winner, while explicit skip and existing account data prohibit merging", async (t) => {
  const { accounts, db, enroll, legacy } = await setup(t);
  const old = await legacy();
  const first = await enroll();
  const second = await enroll();
  const attempts = await Promise.allSettled(
    [first, second].map(({ accountCookie }) =>
      accounts.claim(request(accountCookie, old.cookie), true),
    ),
  );
  assert.equal(
    attempts.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.find(({ status }) => status === "rejected").reason.code,
    "LEGACY_OWNERSHIP_REQUIRED",
  );
  const untouched = await legacy();
  const newAccount = await enroll(undefined, untouched.cookie);
  await accounts.skipClaim(request(newAccount.accountCookie, untouched.cookie));
  assert.equal(
    await accounts.legacyClaimAvailable(
      request(newAccount.accountCookie, untouched.cookie),
      await accounts.read(request(newAccount.accountCookie)),
    ),
    false,
  );
  await assert.rejects(
    accounts.claim(request(newAccount.accountCookie, untouched.cookie), true),
    { code: "LEGACY_ALREADY_CLAIMED" },
  );
  const unrelated = await enroll();
  await db.query(
    "INSERT INTO rocket_direct_connections(id,user_id,label,created_at) VALUES(?,?,?,?)",
    ["other-connection", unrelated.workspace, "Other MT5 connection", 1],
  );
  await assert.rejects(
    accounts.claim(request(unrelated.accountCookie, untouched.cookie), true),
    { code: "LEGACY_WORKSPACE_CONFLICT" },
  );
});
