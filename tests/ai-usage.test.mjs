import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { usageService, tokenPrices } from "../server/ai-usage.mjs";
const env = { OPENAI_MODEL: "gpt-6.1-sol", ROCKET_AI_DAILY_BUDGET_USD: "0.1" };
const payload = {
  input: "Fixture only; no provider request.",
  instructions: "Reply with fixture data",
  max_output_tokens: 2500,
};
test("concurrent reservations enforce the backend budget before provider dispatch", async () => {
  const f = await fixture();
  try {
    const usage = usageService(f.db, { now: f.now, env });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        usage.reserve("alice", payload, env, "analysis"),
      ),
    );
    assert.ok(
      results.some(
        (r) => r.status === "rejected" && r.reason.code === "AI_BUDGET_REACHED",
      ),
    );
    const sum = await usage.totals("alice");
    assert.ok(sum.reservedUsd > 0 && sum.reservedUsd <= 0.1);
    assert.equal(sum.estimatedUsd, 0);
  } finally {
    await f.db.close();
  }
});
test("verified token counts settle once and release only the unused reservation", async () => {
  const f = await fixture();
  try {
    const usage = usageService(f.db, { now: f.now, env });
    const r = await usage.reserve("alice", payload, env, "analysis");
    await usage.settle(r, { input_tokens: 100, output_tokens: 50 });
    await usage.settle(r, { input_tokens: 1000, output_tokens: 500 });
    const sum = await usage.totals("alice");
    assert.equal(sum.inputTokens, 100);
    assert.equal(sum.outputTokens, 50);
    assert.equal(sum.reservedUsd, 0);
    assert.equal(sum.estimatedUsd, 0.0007);
  } finally {
    await f.db.close();
  }
});
test("unknown usage retains the full allowance and fails closed without fabricating tokens", async () => {
  const f = await fixture();
  try {
    const usage = usageService(f.db, {
      now: f.now,
      env,
      provider: async () => ({ usage: null }),
    });
    await assert.rejects(
      usage.responder("alice")(payload, { env }),
      (e) => e.code === "AI_USAGE_UNVERIFIED",
    );
    const sum = await usage.totals("alice");
    assert.ok(sum.estimatedUsd > 0);
    assert.equal(sum.inputTokens, 0);
    assert.equal(sum.reservedUsd, 0);
  } finally {
    await f.db.close();
  }
});
test("unsupported model pricing rejects before a paid provider call", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const usage = usageService(f.db, {
      now: f.now,
      provider: async () => {
        calls++;
      },
    });
    await assert.rejects(
      usage.responder("alice")(payload, {
        env: { OPENAI_MODEL: "gpt-fixture-unknown" },
      }),
      (e) => e.code === "AI_PRICING_REQUIRED",
    );
    assert.equal(calls, 0);
    assert.throws(() =>
      tokenPrices("gpt-fixture", {
        ROCKET_AI_INPUT_USD_PER_MILLION: "-1",
        ROCKET_AI_OUTPUT_USD_PER_MILLION: "2",
      }),
    );
  } finally {
    await f.db.close();
  }
});
test("requests cannot add billable tools or exceed bounded input/output", async () => {
  const f = await fixture();
  try {
    const usage = usageService(f.db, { now: f.now, env });
    for (const patch of [
      { tools: [{ type: "web_search" }] },
      { max_output_tokens: 100000 },
      { input: "X".repeat(150001) },
    ])
      await assert.rejects(
        usage.reserve("alice", { ...payload, ...patch }, env, "analysis"),
      );
    assert.equal((await usage.totals("alice")).requests, 0);
  } finally {
    await f.db.close();
  }
});
test("usage and daily reservations stay isolated between workspaces and reset at UTC day boundaries", async () => {
  const f = await fixture();
  try {
    const usage = usageService(f.db, { now: f.now, env });
    await usage.reserve("alice", payload, env, "analysis");
    assert.equal((await usage.totals("bob")).reservedUsd, 0);
    f.advance(86400000);
    assert.equal((await usage.totals("alice")).reservedUsd, 0);
  } finally {
    await f.db.close();
  }
});
test("STOP before dispatch cancels a reservation without calling or billing the provider", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const usage = usageService(f.db, {
      now: f.now,
      env,
      provider: async () => {
        calls++;
      },
    });
    const guarded = usage.responder("alice", "analysis", {
      beforeDispatch: async () => {
        throw Error("stopped");
      },
    });
    await assert.rejects(guarded(payload, { env }), /stopped/);
    assert.equal(calls, 0);
    const sum = await usage.totals("alice");
    assert.equal(sum.estimatedUsd, 0);
    assert.equal(sum.reservedUsd, 0);
  } finally {
    await f.db.close();
  }
});
