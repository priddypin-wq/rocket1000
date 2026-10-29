import OpenAI from "openai";
import { ApiError } from "./errors.mjs";
import { runtimeAiEnvironment } from "./ai-auth.mjs";

export const MODEL = "gpt-6.1-sol";
export function configuredModel(env = process.env) {
  const model =
    typeof env.OPENAI_MODEL === "string" ? env.OPENAI_MODEL.trim() : MODEL;
  if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(model))
    throw new ApiError(
      503,
      "The server OpenAI model configuration is invalid.",
      "AI_MODEL_INVALID",
    );
  return model;
}
export function isConfiguredModel(value, expected = MODEL) {
  if (typeof value !== "string") return false;
  const name = value.replace(/^openai\//, "");
  return (
    name === expected ||
    (name.startsWith(expected + "-") &&
      /^\d{4}-\d{2}-\d{2}$/.test(name.slice(expected.length + 1)))
  );
}
const OPENAI_BASE = "https://api.openai.com/v1";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/responses";
const credential = (value) => (typeof value === "string" ? value.trim() : "");

// Metadata only: no credential, fingerprint or provider request is returned.
export function aiConfiguration(env = process.env) {
  const model = configuredModel(env);
  if (credential(env.OPENAI_API_KEY))
    return { configured: true, provider: "OpenAI", model };
  if (
    env.ROCKET_OPENAI_DIRECT_ONLY !== "1" &&
    (credential(env.AI_GATEWAY_API_KEY) || credential(env.VERCEL_OIDC_TOKEN))
  )
    return { configured: true, provider: "Vercel AI Gateway", model };
  return {
    configured: false,
    provider:
      env.ROCKET_OPENAI_DIRECT_ONLY === "1" ? "OpenAI" : "Vercel AI Gateway",
    model,
  };
}

function providerFailure({ status, code, type, name } = {}, gateway = false) {
  // Never forward SDK/provider messages, headers, bodies or arbitrary URLs.
  if (gateway && [code, type].includes("customer_verification_required"))
    return new ApiError(
      503,
      "Complete Vercel AI Gateway verification using its billing link in Settings.",
      "AI_VERIFICATION_REQUIRED",
    );
  if ([code, type].includes("insufficient_quota") || status === 402)
    return new ApiError(
      503,
      "AI credits or a billing limit need attention. Open the active provider billing link in Settings.",
      "AI_BILLING_REQUIRED",
    );
  if (status === 401)
    return new ApiError(
      503,
      "AI authentication was rejected. Check the server-side API credential.",
      "AI_AUTH_REQUIRED",
    );
  if (status === 403)
    return new ApiError(
      503,
      "AI access requires account verification or permission for the selected model.",
      "AI_ACCESS_REQUIRED",
    );
  if (status === 404 || [code, type].includes("model_not_found"))
    return new ApiError(
      503,
      "The configured AI model is unavailable to this API project.",
      "AI_MODEL_UNAVAILABLE",
    );
  if (status === 429)
    return new ApiError(
      503,
      "AI request limit reached. Wait before testing or restarting analysis.",
      "AI_RATE_LIMITED",
    );
  if (
    status === 408 ||
    ["AbortError", "TimeoutError", "APIConnectionTimeoutError"].includes(name)
  )
    return new ApiError(
      503,
      "The AI request timed out. Try again after checking the provider connection.",
      "AI_TIMEOUT",
    );
  return new ApiError(
    503,
    "The AI provider could not complete the request. Check connectivity and provider access.",
    "AI_UNAVAILABLE",
  );
}

export async function createAiResponse(
  payload,
  { env = process.env, fetcher = fetch, timeout = 45000, signal } = {},
) {
  const resolved =
    env.ROCKET_OPENAI_DIRECT_ONLY === "1"
      ? env
      : await runtimeAiEnvironment(env);
  const config = aiConfiguration(resolved);
  if (!config.configured)
    throw new ApiError(
      503,
      "Configure OPENAI_API_KEY in the server environment, or activate AI Gateway authentication. Keys never belong in the browser or EA.",
      "AI_AUTH_REQUIRED",
    );
  const gateway = config.provider === "Vercel AI Gateway";
  const boundedTimeout = Number.isFinite(timeout)
    ? Math.max(1000, Math.min(45000, timeout))
    : 45000;
  const body = {
    ...payload,
    model: gateway ? "openai/" + config.model : config.model,
    store: false,
    stream: false,
  };
  if (!gateway) {
    try {
      const client = new OpenAI({
        apiKey: credential(resolved.OPENAI_API_KEY),
        baseURL: OPENAI_BASE,
        organization: null,
        project: null,
        logLevel: "off",
        maxRetries: 0,
        timeout: boundedTimeout,
        fetch: fetcher,
        fetchOptions: { redirect: "error" },
      });
      return await client.responses.create(body, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(boundedTimeout)])
          : AbortSignal.timeout(boundedTimeout),
      });
    } catch (error) {
      throw providerFailure({
        status: error?.status,
        code: error?.code,
        type: error?.type,
        name:
          error instanceof OpenAI.APIConnectionTimeoutError ||
          error instanceof OpenAI.APIUserAbortError
            ? "TimeoutError"
            : error?.name,
      });
    }
  }
  let response;
  try {
    response = await fetcher(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Bearer " +
          credential(resolved.AI_GATEWAY_API_KEY || resolved.VERCEL_OIDC_TOKEN),
      },
      redirect: "error",
      signal: AbortSignal.timeout(boundedTimeout),
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw providerFailure({ name: error?.name }, true);
  }
  if (!response.ok) {
    let failure = {};
    try {
      failure = await response.json();
    } catch {
      /* Provider error bodies are never logged. */
    }
    throw providerFailure(
      {
        status: response.status,
        code: failure?.error?.code || failure?.code,
        type: failure?.error?.type,
      },
      true,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ApiError(
      502,
      "The AI provider returned an invalid response.",
      "AI_INVALID_RESPONSE",
    );
  }
}
