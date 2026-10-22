import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL,
  aiConfiguration,
  analyzeMarket,
  validateAssessment,
} from "../server/ai-analysis.mjs";
import { TIMEFRAMES, adaptiveProfile } from "../server/market.mjs";

// These tests inject deterministic HTTP responses. They are not a real model,
// broker execution, or evidence of a successful paid provider request.
const NOW = 1800000000000;
const PRIVATE_KEY = "fixture-server-key-never-return-to-the-browser";
const env = { OPENAI_API_KEY: PRIVATE_KEY };
function snapshot() {
  const timeframes = Object.fromEntries(
    Object.entries(TIMEFRAMES).map(([name, seconds]) => [
      name,
      {
        bars: Array.from({ length: 100 }, (_, i) => ({
          time:
            Math.floor(NOW / (seconds * 1000)) * seconds - (100 - i) * seconds,
          open: 100 + i,
          high: 101 + i,
          low: 99 + i,
          close: 100.5 + i,
          volume: 100 + i,
        })),
      },
    ]),
  );
  return {
    symbol: "XAUUSD",
    timeframe: "M5",
    timestamp: NOW,
    brokerTimestamp: NOW,
    quoteTimestamp: NOW,
    bid: 200,
    ask: 200.1,
    balance: 18432.81,
    equity: 18425.63,
    currency: "USD",
    positions: [],
    bars: structuredClone(timeframes.M5.bars),
    timeframes,
  };
}
const wait = {
  decision: "WAIT",
  confidence: 0.9,
  strategy: "wait",
  timeframe: "M1",
  entryPrice: null,
  stopLoss: null,
  takeProfit: null,
  reasoning: "No entry is confirmed by the supplied closed candles.",
  risks: [
    "Execution and scheduled-news conditions must be verified separately.",
  ],
};
function signal(side = "BUY", s = snapshot(), overrides = {}) {
  const buy = side === "BUY";
  const entryPrice = buy ? s.ask : s.bid;
  return {
    ...wait,
    decision: side,
    strategy: "trend",
    entryPrice,
    stopLoss: entryPrice + (buy ? -2 : 2),
    takeProfit: entryPrice + (buy ? 4 : -4),
    reasoning:
      "The supplied deterministic fixture confirms this geometric assessment.",
    ...overrides,
  };
}
function provider(assessment = wait, overrides = {}) {
  return {
    id: "resp_fixture_not_a_real_provider_call",
    status: "completed",
    model: MODEL,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(assessment) }],
      },
    ],
    ...overrides,
  };
}
function options(fetcher) {
  return { env, now: () => NOW, fetcher };
}
function invalid(action) {
  assert.throws(
    action,
    (e) => e.status === 502 && e.code === "AI_INVALID_RESPONSE",
  );
}

test("direct OpenAI request uses the exact supported model and strict AI-plan schema with private MTF context", async () => {
  const s = snapshot();
  s.accountLogin = "private-account-number";
  s.credential = "private-terminal-credential";
  let calls = 0;
  const result = await analyzeMarket(
    s,
    options(async (url, request) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(request.method, "POST");
      assert.equal(
        new Headers(request.headers).get("authorization"),
        `Bearer ${PRIVATE_KEY}`,
      );
      const body = JSON.parse(request.body);
      assert.equal(body.model, "gpt-6.1-sol");
      assert.equal(body.store, false);
      assert.equal(body.text.format.type, "json_schema");
      assert.equal(body.text.format.strict, true);
      const schema = body.text.format.schema;
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, [
        ...Object.keys(wait),
        "proposedLots",
        "entryAction",
        "positionActions",
      ]);
      assert.deepEqual(Object.keys(schema.properties), schema.required);
      assert.equal(schema.required.length, 12);
      assert.deepEqual(schema.properties.decision.enum, [
        "BUY",
        "SELL",
        "WAIT",
      ]);
      const context = JSON.parse(body.input);
      assert.equal(context.mode, "balanced");
      assert.equal(context.minimumConfidence, 0.8);
      assert.equal(context.minimumRewardRisk, 1.5);
      assert.deepEqual(Object.keys(context.timeframes), [
        "M1",
        "M5",
        "M15",
        "H1",
      ]);
      for (const [name, frame] of Object.entries(context.timeframes)) {
        assert.deepEqual(
          frame.closedCandles,
          s.timeframes[name].bars.slice(-30),
        );
        assert.ok(Number.isFinite(frame.indicators.rsi14));
        assert.ok(Number.isFinite(frame.indicators.macd.histogram));
        assert.ok(Number.isFinite(frame.indicators.ema50));
        assert.ok(Number.isFinite(frame.indicators.atr14));
        assert.ok(Number.isFinite(frame.indicators.support));
        assert.ok(Number.isFinite(frame.indicators.resistance));
      }
      for (const field of [
        "balance",
        "equity",
        "positions",
        "accountLogin",
        "credential",
        "cookie",
        "lotSize",
      ])
        assert.equal(context[field], undefined);
      for (const value of [
        "private-account-number",
        "private-terminal-credential",
        PRIVATE_KEY,
      ])
        assert.ok(!body.input.includes(value));
      assert.equal(context.accountRisk.balance, s.balance);
      assert.match(
        body.instructions,
        /deterministic engine may only reduce lots or reject/,
      );
      return Response.json(provider());
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.decision, "WAIT");
  assert.equal(result.entryPrice, null);
  assert.equal(result.model, MODEL);
  assert.equal(result.provider, "OpenAI");
  assert.equal(result.executionApproved, false);
  assert.ok(result.executionBlockers.length > 0);
  assert.ok(!JSON.stringify(result).includes(PRIVATE_KEY));
});

test("an explicitly configured OpenAI key wins over automatically supplied Vercel OIDC", async () => {
  const combined = {
    ...env,
    VERCEL: "1",
    VERCEL_OIDC_TOKEN: "fixture-automatic-oidc",
  };
  assert.deepEqual(aiConfiguration(combined), {
    configured: true,
    provider: "OpenAI",
    model: MODEL,
  });
  const result = await analyzeMarket(snapshot(), {
    ...options(async (url, request) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(
        new Headers(request.headers).get("authorization"),
        `Bearer ${PRIVATE_KEY}`,
      );
      return Response.json(provider());
    }),
    env: combined,
  });
  assert.equal(result.provider, "OpenAI");
});

test("Gateway OIDC still targets the exact Sol model without exposing the bearer credential", async () => {
  const result = await analyzeMarket(snapshot(), {
    ...options(async (url, request) => {
      assert.equal(url, "https://ai-gateway.vercel.sh/v1/responses");
      assert.equal(
        new Headers(request.headers).get("authorization"),
        "Bearer fixture-automatic-oidc",
      );
      assert.equal(JSON.parse(request.body).model, "openai/gpt-6.1-sol");
      return Response.json(provider(wait, { model: "openai/gpt-6.1-sol" }));
    }),
    env: { VERCEL_OIDC_TOKEN: "fixture-automatic-oidc" },
  });
  assert.equal(result.provider, "Vercel AI Gateway");
  assert.ok(!JSON.stringify(result).includes("fixture-automatic-oidc"));
});

test("valid BUY and SELL assessments retain their actual entry, SL and TP but never authorize execution", async () => {
  const s = snapshot();
  const profile = adaptiveProfile(s);
  for (const side of ["BUY", "SELL"]) {
    const assessment = signal(side, s);
    assert.equal(validateAssessment(assessment, s, profile), assessment);
    const result = await analyzeMarket(
      s,
      options(async () => Response.json(provider(assessment))),
    );
    assert.equal(result.decision, side);
    assert.equal(result.entryPrice, side === "BUY" ? s.ask : s.bid);
    assert.equal(result.stopLoss, assessment.stopLoss);
    assert.equal(result.takeProfit, assessment.takeProfit);
    assert.equal(result.executionApproved, false);
    assert.equal(result.expiresAt, NOW + 60000);
  }
});

test("invalid BUY/SELL geometry, distant entry, non-finite prices and insufficient reward/risk are rejected", () => {
  const s = snapshot();
  const profile = adaptiveProfile(s);
  for (const side of ["BUY", "SELL"]) {
    const original = signal(side, s);
    const sign = side === "BUY" ? 1 : -1;
    for (const patch of [
      { stopLoss: original.entryPrice },
      { stopLoss: original.entryPrice + sign },
      { takeProfit: original.entryPrice },
      { takeProfit: original.entryPrice - sign },
      { takeProfit: original.entryPrice + sign * 2.5 },
      { entryPrice: original.entryPrice + 1 },
      { entryPrice: 0 },
      { stopLoss: NaN },
      { takeProfit: Infinity },
      { strategy: "wait" },
    ])
      invalid(() => validateAssessment({ ...original, ...patch }, s, profile));
  }
  const aggressive = adaptiveProfile(s, { tradingMode: "aggressive" });
  assert.doesNotThrow(() =>
    validateAssessment(
      signal("BUY", s, { takeProfit: s.ask + 2.5 }),
      s,
      aggressive,
    ),
  );
});

test("WAIT requires all three prices to be null and cannot conceal an executable strategy", () => {
  const s = snapshot();
  const profile = adaptiveProfile(s);
  assert.equal(validateAssessment(wait, s, profile), wait);
  for (const patch of [
    { entryPrice: s.ask },
    { stopLoss: 0 },
    { takeProfit: 202 },
    { strategy: "trend" },
    { entryPrice: undefined },
  ])
    invalid(() => validateAssessment({ ...wait, ...patch }, s, profile));
});

test("the model cannot add lots, raise risk, approve execution or smuggle unknown assessment fields", () => {
  const s = snapshot();
  const profile = adaptiveProfile(s);
  for (const patch of [
    { lots: 100 },
    { lotSize: 100 },
    { riskPerTradePct: 99 },
    { executionApproved: true },
    { liveConfirmed: true },
    { permissionActive: true },
    { accountType: "demo" },
    { allowedStrategies: ["scalping"] },
  ])
    invalid(() => validateAssessment({ ...signal(), ...patch }, s, profile));
  const missing = { ...wait };
  delete missing.risks;
  invalid(() => validateAssessment(missing, s, profile));
  for (const patch of [
    { confidence: 1.01 },
    { confidence: -0.1 },
    { confidence: NaN },
    { reasoning: "   " },
    { risks: [PRIVATE_KEY.repeat(20)] },
    { timeframe: "D1" },
  ])
    invalid(() => validateAssessment({ ...wait, ...patch }, s, profile));
});

test("scalping is rejected when spread costs or selected timeframe violate deterministic permissions", () => {
  const s = snapshot();
  const scalp = signal("BUY", s, { strategy: "scalping", timeframe: "M1" });
  assert.doesNotThrow(() => validateAssessment(scalp, s, adaptiveProfile(s)));
  invalid(() =>
    validateAssessment({ ...scalp, timeframe: "H1" }, s, adaptiveProfile(s)),
  );
  s.ask = s.bid + 0.4;
  assert.equal(adaptiveProfile(s).scalpingEligible, false);
  invalid(() =>
    validateAssessment(
      signal("BUY", s, { strategy: "scalping" }),
      s,
      adaptiveProfile(s),
    ),
  );
  invalid(() =>
    validateAssessment(
      signal("BUY", s, { strategy: "reversal" }),
      s,
      adaptiveProfile(s),
    ),
  );
  invalid(() =>
    validateAssessment(signal("BUY", s), s, {
      ...adaptiveProfile(s),
      allowedStrategies: ["wait"],
    }),
  );
});

test("missing or stale terminal history prevents any provider call", async () => {
  let calls = 0;
  const config = options(async () => {
    calls++;
    return Response.json(provider());
  });
  const missing = snapshot();
  delete missing.timeframes.H1;
  await assert.rejects(
    () => analyzeMarket(missing, config),
    (e) => e.status === 409 && e.code === "MULTI_TIMEFRAME_REQUIRED",
  );
  const stale = snapshot();
  stale.timestamp -= 30001;
  await assert.rejects(
    () => analyzeMarket(stale, config),
    (e) => e.code === "MARKET_DATA_INVALID",
  );
  assert.equal(calls, 0);
});

test("an otherwise valid signal is discarded when its market data becomes stale during the model request", async () => {
  let clock = NOW;
  await assert.rejects(
    () =>
      analyzeMarket(snapshot(), {
        env,
        now: () => clock,
        fetcher: async () => {
          clock += 60001;
          return Response.json(provider(signal()));
        },
      }),
    (e) => e.status === 409 && e.code === "AI_SIGNAL_STALE",
  );
});

test("known Gateway customer verification errors expose only the safe setup instruction", async () => {
  for (const error of [
    { type: "customer_verification_required" },
    { code: "customer_verification_required" },
    { type: "gateway_error", code: "customer_verification_required" },
  ]) {
    await assert.rejects(
      () =>
        analyzeMarket(snapshot(), {
          ...options(async (url) => {
            assert.equal(url, "https://ai-gateway.vercel.sh/v1/responses");
            return Response.json(
              {
                error: {
                  ...error,
                  message: `Private raw detail ${PRIVATE_KEY}`,
                  action_url: "https://untrusted.example/steal",
                },
              },
              { status: 403 },
            );
          }),
          env: { VERCEL_OIDC_TOKEN: "fixture-automatic-oidc" },
        }),
      (e) => {
        assert.equal(e.code, "AI_VERIFICATION_REQUIRED");
        assert.match(e.message, /Vercel AI Gateway verification/);
        assert.ok(!e.message.includes(PRIVATE_KEY));
        assert.ok(!e.message.includes("untrusted.example"));
        assert.ok(!e.message.includes("Private raw detail"));
        return true;
      },
    );
  }
});

test("authentication, credit, access, rate and network failures never manufacture a signal", async () => {
  for (const [status, code] of [
    [401, "AI_AUTH_REQUIRED"],
    [402, "AI_BILLING_REQUIRED"],
    [403, "AI_ACCESS_REQUIRED"],
    [429, "AI_RATE_LIMITED"],
    [500, "AI_UNAVAILABLE"],
  ]) {
    await assert.rejects(
      () =>
        analyzeMarket(
          snapshot(),
          options(async () =>
            Response.json(
              {
                error: {
                  type: "unknown_error",
                  message: PRIVATE_KEY,
                  action_url: "https://untrusted.example/steal",
                },
              },
              { status },
            ),
          ),
        ),
      (e) =>
        e.code === code &&
        !e.message.includes(PRIVATE_KEY) &&
        !e.message.includes("untrusted.example"),
    );
  }
  await assert.rejects(
    () =>
      analyzeMarket(
        snapshot(),
        options(async () => {
          throw new Error(PRIVATE_KEY);
        }),
      ),
    (e) => e.code === "AI_UNAVAILABLE" && !e.message.includes(PRIVATE_KEY),
  );
  await assert.rejects(
    () =>
      analyzeMarket(snapshot(), {
        ...options(() => {
          throw new Error("must not call");
        }),
        env: {},
      }),
    (e) => e.code === "AI_AUTH_REQUIRED",
  );
});

test("wrong models, incomplete responses, refusals, malformed JSON and model-added execution authority fail closed", async () => {
  for (const body of [
    provider(wait, { model: "gpt-6.1-sol-fast" }),
    provider(wait, { model: "gpt-6.1-sol-2026-10-01-extra" }),
    provider(wait, { status: "incomplete" }),
    provider(wait, { id: "" }),
    provider(wait, {
      output: [
        { type: "message", content: [{ type: "refusal", refusal: "No" }] },
      ],
    }),
    provider(wait, {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "not JSON" }],
        },
      ],
    }),
    provider({ ...signal(), executionApproved: true }),
  ]) {
    await assert.rejects(
      () =>
        analyzeMarket(
          snapshot(),
          options(async () => Response.json(body)),
        ),
      (e) => e.code === "AI_INVALID_RESPONSE",
    );
  }
  await assert.rejects(
    () =>
      analyzeMarket(
        snapshot(),
        options(
          async () =>
            new Response(`malformed response ${PRIVATE_KEY}`, {
              headers: { "Content-Type": "application/json" },
            }),
        ),
      ),
    // Invalid JSON on the wire fails in SDK transport parsing, before the
    // assessment validator; its sanitized error must still reject all signals.
    (e) => e.code === "AI_UNAVAILABLE" && !e.message.includes(PRIVATE_KEY),
  );
  const accepted = await analyzeMarket(
    snapshot(),
    options(async () =>
      Response.json(provider(wait, { model: "gpt-6.1-sol-2026-10-01" })),
    ),
  );
  assert.equal(accepted.model, MODEL);
  assert.equal(accepted.executionApproved, false);
});
