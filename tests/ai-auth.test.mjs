import test from "node:test";
import assert from "node:assert/strict";
import { runtimeAiEnvironment } from "../server/ai-auth.mjs";
import { aiConfiguration } from "../server/ai-analysis.mjs";

test("Vercel runtime auth reads the current request token on every call", async () => {
  let calls = 0;
  const env = { VERCEL: "1", VERCEL_OIDC_TOKEN: "old-build-token" };
  const oidc = async () => `current-request-token-${++calls}`;
  const first = await runtimeAiEnvironment(env, { oidc });
  const second = await runtimeAiEnvironment(env, { oidc });
  assert.equal(first.VERCEL_OIDC_TOKEN, "current-request-token-1");
  assert.equal(second.VERCEL_OIDC_TOKEN, "current-request-token-2");
  assert.equal(env.VERCEL_OIDC_TOKEN, "old-build-token");
  assert.equal(aiConfiguration(first).configured, true);
  assert.equal(calls, 2);
});

test("explicit AI credentials and local development do not request runtime OIDC", async () => {
  for (const env of [
    { VERCEL: "1", AI_GATEWAY_API_KEY: "fixture-gateway-key" },
    { VERCEL: "1", OPENAI_API_KEY: "fixture-provider-key" },
    {},
  ]) {
    let called = false;
    const resolved = await runtimeAiEnvironment(env, {
      oidc: async () => {
        called = true;
        throw Error("unexpected");
      },
    });
    assert.equal(resolved, env);
    assert.equal(called, false);
  }
});

test("missing runtime context stays unconfigured without exposing helper errors", async () => {
  const env = { VERCEL: "1" };
  const resolved = await runtimeAiEnvironment(env, {
    oidc: async () => {
      throw Error("private helper detail");
    },
  });
  assert.equal(aiConfiguration(resolved).configured, false);
  assert.equal(resolved, env);
});
