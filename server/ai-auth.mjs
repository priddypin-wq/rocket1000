import { getVercelOidcToken } from "@vercel/oidc";

// Runtime OIDC tokens arrive through Vercel's request context, not only process.env.
// Resolve on each request so token rotation never leaves a cached bearer token.
export async function runtimeAiEnvironment(
  env = process.env,
  { oidc = getVercelOidcToken } = {},
) {
  if (env.VERCEL !== "1" || env.AI_GATEWAY_API_KEY || env.OPENAI_API_KEY)
    return env;
  try {
    const token = await oidc();
    if (typeof token === "string" && token.trim())
      return { ...env, VERCEL_OIDC_TOKEN: token };
  } catch {
    // A missing request context must retain the explicit, fail-closed auth error.
  }
  return env;
}
