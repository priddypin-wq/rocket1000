import test from "node:test";
import assert from "node:assert/strict";
import {
  aiConfiguration,
  createAiResponse,
  MODEL,
  isConfiguredModel,
} from "../server/ai-provider.mjs";

// Official SDK transport fixtures only. Never contacts an AI provider or broker.
const fixtureKey = "sk-fixture-not-a-real-key";
const privateMessage = "private-provider-detail-never-return";
const completed = {
  id: "resp_sdk_fixture",
  status: "completed",
  model: MODEL,
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ROCKET1000_OK" }],
    },
  ],
};
const env = { OPENAI_API_KEY: fixtureKey };
const request = {
  model: MODEL,
  input: "fixed diagnostic fixture",
  max_output_tokens: 256,
};

test("server AI configuration prioritizes the direct key and returns metadata only", () => {
  const both = {
    OPENAI_API_KEY: fixtureKey,
    AI_GATEWAY_API_KEY: "fixture-gateway-secret",
    VERCEL_OIDC_TOKEN: "fixture-oidc-secret",
  };
  assert.deepEqual(aiConfiguration(both), {
    configured: true,
    provider: "OpenAI",
    model: MODEL,
  });
  assert.deepEqual(Object.keys(aiConfiguration(both)).sort(), [
    "configured",
    "model",
    "provider",
  ]);
  assert.equal(
    aiConfiguration({ OPENAI_API_KEY: "  ", AI_GATEWAY_API_KEY: "fixture" })
      .provider,
    "Vercel AI Gateway",
  );
  assert.equal(aiConfiguration({ OPENAI_API_KEY: "  " }).configured, false);
  for (const secret of Object.values(both))
    assert.ok(!JSON.stringify(aiConfiguration(both)).includes(secret));
});

test("the official SDK pins the OpenAI host, protects credentials and forces the configured model without storage", async () => {
  let calls = 0;
  const result = await createAiResponse(
    { ...request, model: "untrusted-model", store: true, stream: true },
    {
      env: {
        ...env,
        OPENAI_API_KEY: ` ${fixtureKey} `,
        OPENAI_BASE_URL: "https://attacker.example/v1",
      },
      fetcher: async (url, options) => {
        calls++;
        assert.equal(String(url), "https://api.openai.com/v1/responses");
        assert.ok(!String(url).includes(fixtureKey));
        const headers = new Headers(options.headers);
        assert.equal(headers.get("authorization"), `Bearer ${fixtureKey}`);
        assert.match(headers.get("user-agent"), /^OpenAI\/JS/);
        assert.equal(headers.get("openai-organization"), null);
        assert.equal(headers.get("openai-project"), null);
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.signal.aborted, false);
        const body = JSON.parse(options.body);
        assert.equal(body.model, MODEL);
        assert.equal(body.store, false);
        assert.equal(body.stream, false);
        assert.equal(body.input, request.input);
        assert.ok(!options.body.includes(fixtureKey));
        return Response.json(completed);
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.id, completed.id);
  assert.equal(result.output[0].content[0].text, "ROCKET1000_OK");
});

test("missing server credentials fail before invoking any transport", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      createAiResponse(request, {
        env: {},
        fetcher: () => {
          calls++;
          throw Error("unexpected network");
        },
      }),
    (error) => error.code === "AI_AUTH_REQUIRED",
  );
  assert.equal(calls, 0);
});

for (const [status, providerCode, expected] of [
  [401, "invalid_api_key", "AI_AUTH_REQUIRED"],
  [403, "permission_denied", "AI_ACCESS_REQUIRED"],
  [404, "model_not_found", "AI_MODEL_UNAVAILABLE"],
  [429, "insufficient_quota", "AI_BILLING_REQUIRED"],
  [429, "rate_limit_exceeded", "AI_RATE_LIMITED"],
  [500, "server_error", "AI_UNAVAILABLE"],
]) {
  test(`SDK HTTP ${status}/${providerCode} is sanitized, not retried and never falls back to another paid provider`, async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        createAiResponse(request, {
          env: {
            ...env,
            AI_GATEWAY_API_KEY: "fixture-gateway-must-not-be-used",
          },
          fetcher: async (url) => {
            calls++;
            assert.equal(String(url), "https://api.openai.com/v1/responses");
            return Response.json(
              {
                error: {
                  message: `${privateMessage} ${fixtureKey}`,
                  code: providerCode,
                  type: providerCode,
                },
              },
              { status },
            );
          },
        }),
      (error) => {
        assert.equal(error.code, expected);
        assert.equal(error.status, 503);
        for (const secret of [privateMessage, fixtureKey]) {
          assert.ok(!error.message.includes(secret));
          assert.ok(!JSON.stringify(error).includes(secret));
        }
        return true;
      },
    );
    assert.equal(calls, 1);
  });
}

test("SDK logging stays disabled even if its environment requests debug logging", async () => {
  const originalLog = process.env.OPENAI_LOG;
  const originalOrg = process.env.OPENAI_ORG_ID;
  const originalProject = process.env.OPENAI_PROJECT_ID;
  const methods = ["debug", "info", "warn", "error", "log"];
  const originalConsole = Object.fromEntries(
    methods.map((name) => [name, console[name]]),
  );
  const logs = [];
  try {
    process.env.OPENAI_LOG = "debug";
    process.env.OPENAI_ORG_ID = "fixture-private-organization";
    process.env.OPENAI_PROJECT_ID = "fixture-private-project";
    for (const name of methods)
      console[name] = (...args) => {
        logs.push(args);
      };
    await createAiResponse(request, {
      env,
      fetcher: async (_url, options) => {
        const headers = new Headers(options.headers);
        assert.equal(headers.get("openai-organization"), null);
        assert.equal(headers.get("openai-project"), null);
        return Response.json(completed);
      },
    });
    await assert.rejects(() =>
      createAiResponse(request, {
        env,
        fetcher: async () => {
          return Response.json(
            {
              error: {
                message: `${privateMessage} ${fixtureKey}`,
                code: "invalid_api_key",
              },
            },
            { status: 401 },
          );
        },
      }),
    );
  } finally {
    for (const name of methods) console[name] = originalConsole[name];
    for (const [name, value] of [
      ["OPENAI_LOG", originalLog],
      ["OPENAI_ORG_ID", originalOrg],
      ["OPENAI_PROJECT_ID", originalProject],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.deepEqual(logs, []);
});

test("changing the server key is used by the next SDK call without retaining an old client", async () => {
  const seen = [];
  for (const key of ["fixture-first-key", "fixture-rotated-key"])
    await createAiResponse(request, {
      env: { OPENAI_API_KEY: key },
      fetcher: async (_url, options) => {
        seen.push(new Headers(options.headers).get("authorization"));
        return Response.json(completed);
      },
    });
  assert.deepEqual(seen, [
    "Bearer fixture-first-key",
    "Bearer fixture-rotated-key",
  ]);
});

test("SDK request timeout aborts its single transport attempt and returns a safe error", async () => {
  let calls = 0;
  const startedAt = performance.now();
  await assert.rejects(
    () =>
      createAiResponse(request, {
        env,
        timeout: 1000,
        fetcher: async (_url, options) => {
          calls++;
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException(
                    `${privateMessage} ${fixtureKey}`,
                    "TimeoutError",
                  ),
                ),
              { once: true },
            );
          });
        },
      }),
    (error) =>
      error.code === "AI_TIMEOUT" && !error.message.includes(fixtureKey),
  );
  assert.equal(calls, 1);
  assert.ok(performance.now() - startedAt < 5000);
});

test("Gateway compatibility remains available only when no direct API key is configured", async () => {
  const result = await createAiResponse(request, {
    env: { AI_GATEWAY_API_KEY: "fixture-gateway-only" },
    fetcher: async (url, options) => {
      assert.equal(url, "https://ai-gateway.vercel.sh/v1/responses");
      assert.equal(
        options.headers.Authorization,
        "Bearer fixture-gateway-only",
      );
      assert.equal(options.redirect, "error");
      assert.equal(JSON.parse(options.body).model, "openai/" + MODEL);
      return Response.json(completed);
    },
  });
  assert.equal(result.id, completed.id);
});

test("a configurable reasoning model is pinned to server configuration and checked against its actual response family", async () => {
  const model = "gpt-6-luna";
  assert.equal(isConfiguredModel(model, model), true);
  assert.equal(isConfiguredModel(model + "-2026-10-01", model), true);
  assert.equal(isConfiguredModel(MODEL, model), false);
  assert.equal(isConfiguredModel(model + "-unexpected", model), false);
  const result = await createAiResponse(
    { ...request, model: "untrusted-browser-model" },
    {
      env: { ...env, OPENAI_MODEL: model },
      fetcher: async (_url, options) => {
        assert.equal(JSON.parse(options.body).model, model);
        return Response.json({ ...completed, model });
      },
    },
  );
  assert.equal(result.model, model);
});

test("workspace direct-only mode cannot fall back to Gateway after key removal", async () => {
  await assert.rejects(
    createAiResponse(request, {
      env: {
        ROCKET_OPENAI_DIRECT_ONLY: "1",
        VERCEL: "1",
        AI_GATEWAY_API_KEY: "fixture-must-not-be-used",
        VERCEL_OIDC_TOKEN: "fixture-must-not-be-used",
      },
      fetcher: () => assert.fail("no paid fallback request is allowed"),
    }),
    { code: "AI_AUTH_REQUIRED" },
  );
});
