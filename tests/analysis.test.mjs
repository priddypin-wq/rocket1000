import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMarket,
  aiConfiguration,
  MODEL,
} from "../server/ai-analysis.mjs";
import { analysisService } from "../server/analysis-service.mjs";
import {
  validateSnapshot,
  technicals,
  adaptiveProfile,
} from "../server/market.mjs";
import { ApiError } from "../server/errors.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { NOW, terminal, market, fixture, decision } from "./helpers.mjs";
const response = (overrides = {}) => ({
  id: "resp_test",
  status: "completed",
  model: MODEL,
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(decision) }],
    },
  ],
  ...overrides,
});
const aiFixture = {
  env: { VERCEL_OIDC_TOKEN: "unit-test-only" },
  now: () => NOW,
};
// Custom analyzer fixtures are explicit model responses, never paid provider calls.
const assessment = (snapshot, timestamp = NOW) => ({
  ...decision,
  engineVersion: ENGINE_VERSION,
  model: MODEL,
  symbol: snapshot.symbol,
  profile: adaptiveProfile(snapshot),
  responseId: "resp_fixture_not_a_provider_call",
  analyzedAt: timestamp,
  marketTimestamp: snapshot.timestamp,
  expiresAt: snapshot.timestamp + 60000,
  executionApproved: false,
});

test("market telemetry sanitizes fields and computes actual candle indicators", () => {
  const clean = validateSnapshot(
    { ...market(), credential: "never-persist-this" },
    NOW,
  );
  assert.equal(clean.credential, undefined);
  const t = technicals(clean);
  assert.ok(t.ema9 > t.ema21);
  assert.equal(t.atr14, 2);
  assert.equal(t.priorHigh, 2099);
  assert.equal(t.bullishSweep, false);
  assert.ok(t.windowVwap > 2040 && t.windowVwap < 2060);
  const swept = structuredClone(clean);
  swept.bars.at(-1).low = 1900;
  assert.equal(technicals(swept).bullishSweep, true);
  for (const patch of [
    { timestamp: NOW - 30001 },
    { quoteTimestamp: NOW - 15001 },
    { brokerTimestamp: NOW + 86400001 },
    { bid: NaN },
    { ask: 2099 },
    { timeframe: "H1" },
    { bars: clean.bars.slice(0, 49) },
    { bars: [...clean.bars].reverse() },
    { positions: [{ symbol: "XAUUSD", side: "BUY", volume: -1 }] },
  ]) {
    assert.throws(
      () => validateSnapshot({ ...clean, ...patch }, NOW),
      (e) => e.code === "MARKET_DATA_INVALID",
    );
  }
  const old = market();
  old.bars = old.bars.map((b) => ({ ...b, time: b.time - 86400 }));
  assert.throws(
    () => validateSnapshot(old, NOW),
    (e) => e.code === "MARKET_DATA_INVALID",
  );
});

test("Gateway OIDC requests the exact Sol model, structured output, and no private account data", async () => {
  let called = 0;
  const result = await analyzeMarket(market(), {
    ...aiFixture,
    fetcher: async (url, options) => {
      called++;
      assert.equal(url, "https://ai-gateway.vercel.sh/v1/responses");
      assert.equal(options.headers.Authorization, "Bearer unit-test-only");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "openai/gpt-6.1-sol");
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      const context = JSON.parse(body.input);
      assert.deepEqual(Object.keys(context.timeframes), [
        "M1",
        "M5",
        "M15",
        "H1",
      ]);
      for (const frame of Object.values(context.timeframes))
        assert.equal(frame.closedCandles.length, 30);
      for (const name of [
        "balance",
        "equity",
        "positions",
        "accountLogin",
        "credential",
        "cookie",
      ])
        assert.equal(context[name], undefined);
      assert.equal(context.accountRisk.balance, market().balance);
      return Response.json(response());
    },
  });
  assert.equal(called, 1);
  assert.equal(result.model, MODEL);
  assert.equal(result.decision, "WAIT");
  assert.equal(result.executionApproved, false);
  assert.ok(result.executionBlockers.length > 0);
});

test("direct OpenAI SDK analysis takes priority and retains strict market assessment without private account data", async () => {
  assert.equal(aiConfiguration({}).configured, false);
  assert.equal(
    aiConfiguration({ VERCEL_OIDC_TOKEN: "test" }).provider,
    "Vercel AI Gateway",
  );
  await analyzeMarket(market(), {
    env: {
      OPENAI_API_KEY: "unit-test-only",
      AI_GATEWAY_API_KEY: "unused-gateway-fixture",
      VERCEL_OIDC_TOKEN: "unused-oidc-fixture",
    },
    now: () => NOW,
    fetcher: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(
        new Headers(options.headers).get("authorization"),
        "Bearer unit-test-only",
      );
      const body = JSON.parse(options.body);
      assert.equal(body.model, MODEL);
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      assert.equal(body.text.format.schema.required.length, 12);
      const context = JSON.parse(body.input);
      assert.deepEqual(Object.keys(context.timeframes), [
        "M1",
        "M5",
        "M15",
        "H1",
      ]);
      for (const name of [
        "balance",
        "equity",
        "positions",
        "accountLogin",
        "credential",
        "cookie",
      ])
        assert.equal(context[name], undefined);
      assert.equal(context.accountRisk.balance, market().balance);
      return Response.json(response({ model: "gpt-6.1-sol-2026-10-01" }));
    },
  });
});

test("missing authentication and provider failures never produce a fabricated signal", async () => {
  await assert.rejects(
    () =>
      analyzeMarket(market(), {
        env: {},
        now: () => NOW,
        fetcher: () => {
          throw Error("must not call");
        },
      }),
    (e) => e.code === "AI_AUTH_REQUIRED",
  );
  for (const [status, code] of [
    [401, "AI_AUTH_REQUIRED"],
    [402, "AI_BILLING_REQUIRED"],
    [403, "AI_ACCESS_REQUIRED"],
    [429, "AI_RATE_LIMITED"],
    [500, "AI_UNAVAILABLE"],
  ]) {
    await assert.rejects(
      () =>
        analyzeMarket(market(), {
          ...aiFixture,
          fetcher: async () =>
            new Response("private provider error", { status }),
        }),
      (e) => e.code === code && !e.message.includes("private"),
    );
  }
  await assert.rejects(
    () =>
      analyzeMarket(market(), {
        ...aiFixture,
        fetcher: async () => {
          throw Error("network");
        },
      }),
    (e) => e.code === "AI_UNAVAILABLE",
  );
});

test("wrong models, incomplete responses, refusals, malformed JSON and invalid assessments fail closed", async () => {
  const text = (value) => [
    { type: "message", content: [{ type: "output_text", text: value }] },
  ];
  for (const payload of [
    null,
    response({ model: "gpt-6.1-sol-fast" }),
    response({ status: "incomplete" }),
    response({ output: {} }),
    response({ output: [null] }),
    response({
      output: [
        { type: "message", content: [{ type: "refusal", refusal: "No" }] },
      ],
    }),
    response({ output: text("null") }),
    response({ output: text("not JSON") }),
    response({
      output: text(JSON.stringify({ ...decision, confidence: 1.1 })),
    }),
    response({
      output: text(JSON.stringify({ ...decision, executionApproved: true })),
    }),
  ]) {
    await assert.rejects(
      () =>
        analyzeMarket(market(), {
          ...aiFixture,
          fetcher: async () => Response.json(payload),
        }),
      (e) => e.code === "AI_INVALID_RESPONSE",
    );
  }
});

test("demo registration, reconnect and analysis retain the verified account type and never authorize execution", async () => {
  const f = await fixture();
  let calls = 0;
  const analysis = analysisService(f.db, {
    now: f.now,
    analyzer: async (snapshot) => {
      calls++;
      return assessment(snapshot, f.now());
    },
  });
  const demoTerminal = { ...terminal, accountType: "demo", market: market() };
  try {
    const registered = await f.service.telemetry(f.token, demoTerminal, true);
    assert.equal(registered.ok, true);
    assert.equal(registered.tradingEnabled, false);
    assert.equal(registered.command, "NONE");
    const [connected] = await f.service.list("alice");
    assert.equal(connected.status, "Connected");
    assert.equal(connected.installation.accountType, "demo");
    assert.equal(connected.expectedType, "demo");
    const result = await analysis.start("alice");
    assert.equal(result.executionApproved, false);
    assert.equal(calls, 1);
    assert.equal((await analysis.status("alice")).accountType, "demo");
    f.advance(90001);
    assert.equal((await f.service.list("alice"))[0].status, "Disconnected");
    const reconnected = await f.service.telemetry(
      f.token,
      { ...terminal, accountType: "demo" },
      false,
    );
    assert.equal(reconnected.tradingEnabled, false);
    assert.equal((await f.service.list("alice"))[0].status, "Connected");
    await assert.rejects(
      () => f.service.telemetry(f.token, terminal, true),
      (e) => e.code === "ACCOUNT_MISMATCH",
    );
  } finally {
    await f.db.close();
  }
});

test("unsupported account types cannot bind an installation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () =>
        f.service.telemetry(
          f.token,
          { ...terminal, accountType: "contest" },
          true,
        ),
      (e) => e.status === 400,
    );
    assert.equal((await f.service.list("alice"))[0].expectedLogin, null);
  } finally {
    await f.db.close();
  }
});

test("analysis requires connection and fresh candles; results stay private and rate limited", async () => {
  const f = await fixture();
  let calls = 0;
  const service = analysisService(f.db, {
    now: f.now,
    analyzer: async (snapshot) => {
      calls++;
      assert.equal(snapshot.symbol, "XAUUSD");
      return assessment(snapshot, f.now());
    },
  });
  try {
    await assert.rejects(
      () => service.start("alice"),
      (e) => e.code === "MT5_NOT_CONNECTED",
    );
    await f.service.telemetry(f.token, terminal, true);
    await assert.rejects(
      () => service.start("alice"),
      (e) => e.code === "MARKET_DATA_STALE",
    );
    await f.service.telemetry(
      f.token,
      { ...terminal, market: market() },
      false,
    );
    assert.equal((await service.start("alice")).executionApproved, false);
    assert.equal((await service.status("alice")).latest.status, "completed");
    assert.equal((await service.status("bob")).latest, null);
    assert.equal((await service.status("bob")).market, null);
    await assert.rejects(
      () => service.start("alice"),
      (e) => e.code === "ANALYSIS_RATE_LIMITED",
    );
    assert.equal(calls, 1);
    f.advance(60001);
    await assert.rejects(
      () => service.start("alice"),
      (e) => e.code === "MARKET_DATA_STALE",
    );
    assert.equal((await service.status("alice")).market.fresh, false);
  } finally {
    await f.db.close();
  }
});

test("concurrent starts issue only one provider request", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    await f.service.telemetry(f.token, { ...terminal, market: market() }, true);
    const service = analysisService(f.db, {
      now: f.now,
      analyzer: async (snapshot) => {
        calls++;
        return assessment(snapshot, f.now());
      },
    });
    const results = await Promise.allSettled([
      service.start("alice"),
      service.start("alice"),
    ]);
    assert.equal(calls, 1);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.code,
      "ANALYSIS_RATE_LIMITED",
    );
  } finally {
    await f.db.close();
  }
});

for (const change of ["stop", "revoke", "rotate", "disconnect"])
  test(`${change} during model request prevents a completed analysis`, async () => {
    const f = await fixture();
    let release, began;
    const entered = new Promise((resolve) => {
      began = resolve;
    });
    const deferred = new Promise((resolve) => {
      release = resolve;
    });
    const service = analysisService(f.db, {
      now: f.now,
      analyzer: async (snapshot) => {
        began();
        await deferred;
        return assessment(snapshot, f.now());
      },
    });
    try {
      await f.service.telemetry(
        f.token,
        { ...terminal, market: market() },
        true,
      );
      const task = service.start("alice");
      const rejected = assert.rejects(
        task,
        (e) => e.code === "ANALYSIS_CANCELLED",
      );
      await entered;
      if (change === "stop") await f.service.stop("alice");
      if (change === "revoke") await f.service.revoke("alice", f.id);
      if (change === "rotate") await f.download();
      if (change === "disconnect") f.advance(90001);
      release();
      await rejected;
      const [row] = await f.db.query(
        "SELECT status,result FROM rocket_analyses WHERE connection_id=?",
        [f.id],
      );
      assert.notEqual(row.status, "completed");
      assert.equal(row.result, null);
      if (change === "rotate") {
        assert.equal((await service.status("alice")).latest, null);
        assert.equal((await service.status("alice")).market, null);
      }
    } finally {
      release?.();
      await f.db.close();
    }
  });

test("provider failure is persisted without exposing raw provider details", async () => {
  const f = await fixture();
  try {
    await f.service.telemetry(f.token, { ...terminal, market: market() }, true);
    const service = analysisService(f.db, {
      now: f.now,
      analyzer: async () => {
        throw new ApiError(
          503,
          "AI authentication was rejected.",
          "AI_AUTH_REQUIRED",
        );
      },
    });
    await assert.rejects(
      () => service.start("alice"),
      (e) => e.code === "AI_AUTH_REQUIRED",
    );
    const state = await service.status("alice");
    assert.equal(state.latest.status, "error");
    assert.equal(state.latest.result, null);
    assert.equal(state.latest.error, "AI authentication was rejected.");
  } finally {
    await f.db.close();
  }
});
