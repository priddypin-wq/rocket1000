import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "./errors.mjs";
import { runtimeAiEnvironment } from "./ai-auth.mjs";
import {
  aiConfiguration,
  createAiResponse,
  isConfiguredModel,
} from "./ai-provider.mjs";

const TEST_INTERVAL = 60000;
const TEST_LEASE = 60000;
const SUCCESS_LIFETIME = 15 * 60000;
const BUDGET_ID = "connection-test";
const EXPECTED_OUTPUT = "ROCKET1000_OK";
const errors = {
  AI_AUTH_REQUIRED:
    "AI authentication was rejected. Check the server-side API credential.",
  AI_BILLING_REQUIRED:
    "AI credits or a billing limit need attention in the active provider account.",
  AI_ACCESS_REQUIRED:
    "The AI account does not have permission to use the selected model.",
  AI_MODEL_UNAVAILABLE:
    "The configured model is not available to this AI account.",
  AI_RATE_LIMITED:
    "The AI provider request limit was reached. Wait before testing again.",
  AI_VERIFICATION_REQUIRED:
    "Complete verification in the active AI provider account.",
  AI_TIMEOUT: "The AI connection test timed out. Wait before testing again.",
  AI_INVALID_RESPONSE:
    "The AI provider did not return a valid connection-test response.",
  AI_UNAVAILABLE: "The AI provider could not be reached. Try again later.",
  AI_TEST_INTERRUPTED:
    "The AI connection test was interrupted. Wait before testing again.",
  AI_CONFIGURATION_CHANGED:
    "The AI configuration changed during the test. Run a new connection test.",
  AI_BUDGET_REACHED:
    "The backend AI usage budget is reached. New paid requests are suspended.",
  AI_USAGE_UNVERIFIED:
    "The provider did not return verifiable usage. New paid requests are suspended.",
  AI_PRICING_REQUIRED:
    "Verified pricing must be configured for the selected model before making paid requests.",
};

function safeError(error) {
  const code =
    error instanceof ApiError && Object.hasOwn(errors, error.code)
      ? error.code
      : "AI_UNAVAILABLE";
  return { errorCode: code, error: errors[code] };
}

function fingerprint(env, config) {
  // Exact explicit-key binding invalidates a previous success after key rotation.
  // OIDC bearer tokens rotate normally; their project/team scope is the identity.
  const explicitKey = (value) =>
    typeof value === "string" ? value.trim() : "";
  const credential =
    config.provider === "OpenAI"
      ? explicitKey(env.OPENAI_API_KEY)
      : explicitKey(env.AI_GATEWAY_API_KEY) ||
        (env.VERCEL_PROJECT_ID && env.VERCEL_TEAM_ID
          ? `oidc:${env.VERCEL_PROJECT_ID}:${env.VERCEL_TEAM_ID}`
          : env.VERCEL_OIDC_TOKEN);
  return createHash("sha256")
    .update(`${config.provider}\0${config.model}\0${credential || ""}`)
    .digest("hex");
}

function validResponse(response, model) {
  if (
    response?.status !== "completed" ||
    !isConfiguredModel(response.model, model) ||
    !Array.isArray(response.output)
  )
    return false;
  const text = response.output
    .filter((item) => item?.type === "message" && item.role === "assistant")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((item) => item?.type === "output_text")
    .map((item) => item.text)
    .join("");
  return typeof text === "string" && text.trim() === EXPECTED_OUTPUT;
}

// This service has no trading dependency. The fixed diagnostic prompt contains no
// account data, tools or instructions that can create a signal or broker order.
/**
 * @param {*} db
 * @param {{now?: ()=>number, env?: NodeJS.ProcessEnv, responder?: typeof createAiResponse, resolveEnvironment?: (uid:string)=>Promise<NodeJS.ProcessEnv>, beforeRequest?: (uid:string, request:*)=>Promise<*>}} [options]
 */
export function aiConnectionService(
  db,
  {
    now = Date.now,
    env = process.env,
    responder = createAiResponse,
    resolveEnvironment,
    beforeRequest,
  } = {},
) {
  async function configuration(uid) {
    const resolved = resolveEnvironment ? await resolveEnvironment(uid) : env;
    const runtimeEnv =
      resolved.ROCKET_OPENAI_DIRECT_ONLY === "1"
        ? resolved
        : await runtimeAiEnvironment(resolved);
    const config = aiConfiguration(runtimeEnv);
    return { runtimeEnv, config, hash: fingerprint(runtimeEnv, config) };
  }

  async function status(uid) {
    const { config, hash } = await configuration(uid);
    const base = {
      ...config,
      state: config.configured ? "configured" : "unconfigured",
      connected: false,
      checkedAt: null,
      lastSuccessAt: null,
      errorCode: null,
      error: null,
    };
    if (!config.configured) return base;
    const [row] = await db.query(
      "SELECT * FROM rocket_ai_connection_checks WHERE user_id=?",
      [uid],
    );
    if (!row || row.config_hash !== hash) return base;
    const checkedAt = Number(row.checked_at);
    const lastSuccessAt = row.last_success_at
      ? Number(row.last_success_at)
      : null;
    if (row.state === "testing") {
      return now() < Number(row.lease_until)
        ? { ...base, state: "testing", checkedAt, lastSuccessAt }
        : {
            ...base,
            state: "error",
            checkedAt,
            lastSuccessAt,
            errorCode: "AI_TEST_INTERRUPTED",
            error: errors.AI_TEST_INTERRUPTED,
          };
    }
    if (row.state === "connected") {
      const current =
        checkedAt <= now() && now() - checkedAt < SUCCESS_LIFETIME;
      return {
        ...base,
        state: current ? "connected" : "configured",
        connected: current,
        checkedAt,
        lastSuccessAt,
      };
    }
    const failure = safeError(new ApiError(503, "", row.error_code));
    return { ...base, state: "error", checkedAt, lastSuccessAt, ...failure };
  }

  async function test(uid) {
    const { runtimeEnv, config, hash } = await configuration(uid);
    if (!config.configured)
      throw new ApiError(
        503,
        "Configure the server-side OpenAI API key or AI Gateway authentication first.",
        "AI_AUTH_REQUIRED",
      );
    const requestId = randomUUID();
    const startedAt = now();
    await db.transaction(async (tx) => {
      const [workspace] = await tx.query(
        `SELECT id FROM rocket_workspaces WHERE id=? AND expires_at>?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [uid, startedAt],
      );
      if (!workspace)
        throw new ApiError(
          401,
          "A private workspace session is required.",
          "BROWSER_SESSION_REQUIRED",
        );
      const [prior] = await tx.query(
        "SELECT checked_at FROM rocket_ai_connection_checks WHERE user_id=?",
        [uid],
      );
      if (prior && startedAt - Number(prior.checked_at) < TEST_INTERVAL)
        throw new ApiError(
          429,
          "Wait one minute before testing AI again.",
          "AI_TEST_RATE_LIMITED",
        );
      const hour = Math.floor(startedAt / 3600000);
      const day = Math.floor(startedAt / 86400000);
      await tx.query(
        "INSERT INTO rocket_ai_connection_budget(id,hour_bucket,hour_hits,day_bucket,day_hits) VALUES(?,?,0,?,0) ON CONFLICT(id) DO NOTHING",
        [BUDGET_ID, hour, day],
      );
      const [budget] = await tx.query(
        `SELECT * FROM rocket_ai_connection_budget WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [BUDGET_ID],
      );
      if (Number(budget.lease_until) > startedAt)
        throw new ApiError(
          429,
          "Another AI connection test is running. Try again shortly.",
          "AI_TEST_BUSY",
        );
      const hourHits =
        Number(budget.hour_bucket) === hour ? Number(budget.hour_hits) : 0;
      const dayHits =
        Number(budget.day_bucket) === day ? Number(budget.day_hits) : 0;
      if (hourHits >= 10 || dayHits >= 100)
        throw new ApiError(
          429,
          "The connection-test safety budget is reached. Try again later.",
          "AI_TEST_BUDGET_LIMITED",
        );
      await tx.query(
        "UPDATE rocket_ai_connection_budget SET hour_bucket=?,hour_hits=?,day_bucket=?,day_hits=?,lease_id=?,lease_until=? WHERE id=?",
        [
          hour,
          hourHits + 1,
          day,
          dayHits + 1,
          requestId,
          startedAt + TEST_LEASE,
          BUDGET_ID,
        ],
      );
      await tx.query(
        "INSERT INTO rocket_ai_connection_checks(user_id,config_hash,provider,model,state,checked_at,request_id,lease_until) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET config_hash=excluded.config_hash,provider=excluded.provider,model=excluded.model,state=excluded.state,checked_at=excluded.checked_at,last_success_at=CASE WHEN rocket_ai_connection_checks.config_hash=excluded.config_hash THEN rocket_ai_connection_checks.last_success_at ELSE NULL END,error_code=NULL,error=NULL,request_id=excluded.request_id,lease_until=excluded.lease_until",
        [
          uid,
          hash,
          config.provider,
          config.model,
          "testing",
          startedAt,
          requestId,
          startedAt + TEST_LEASE,
        ],
      );
    });
    let failure = null;
    let reservation;
    try {
      reservation = await beforeRequest?.(uid, {
        model: config.model,
        maxOutputTokens: 256,
        purpose: "connection-test",
      });
      const result = await responder(
        {
          model: config.model,
          instructions:
            "This is a connection diagnostic. Reply with exactly ROCKET1000_OK and nothing else.",
          input: "ROCKET1000 connection test. Return ROCKET1000_OK.",
          reasoning: { effort: "low" },
          max_output_tokens: 256,
          store: false,
        },
        { env: runtimeEnv, timeout: 45000 },
      );
      await reservation?.complete?.(result);
      if (!validResponse(result, config.model))
        throw new ApiError(
          502,
          errors.AI_INVALID_RESPONSE,
          "AI_INVALID_RESPONSE",
        );
      if (now() >= startedAt + TEST_LEASE)
        throw new ApiError(
          503,
          errors.AI_TEST_INTERRUPTED,
          "AI_TEST_INTERRUPTED",
        );
      if ((await configuration(uid)).hash !== hash)
        throw new ApiError(
          409,
          errors.AI_CONFIGURATION_CHANGED,
          "AI_CONFIGURATION_CHANGED",
        );
    } catch (error) {
      await reservation?.fail?.(error);
      failure = safeError(error);
    }
    await db.transaction(async (tx) => {
      // Keep the same budget-before-check lock order as reservation. An expired
      // request may finish while another Vercel instance reserves its successor.
      await tx.query(
        "UPDATE rocket_ai_connection_budget SET lease_id=NULL,lease_until=0 WHERE id=? AND lease_id=?",
        [BUDGET_ID, requestId],
      );
      await tx.query(
        "UPDATE rocket_ai_connection_checks SET state=?,checked_at=?,last_success_at=CASE WHEN ?=1 THEN ? ELSE last_success_at END,error_code=?,error=?,lease_until=0 WHERE user_id=? AND request_id=? AND config_hash=? AND state='testing'",
        [
          failure ? "error" : "connected",
          now(),
          failure ? 0 : 1,
          now(),
          failure?.errorCode || null,
          failure?.error || null,
          uid,
          requestId,
          hash,
        ],
      );
    });
    return status(uid);
  }
  return { status, test };
}
