import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rocket1000-demo-test-"));
process.env.ROCKET1000_EA_TOKEN = "test-only-token-with-at-least-24-characters";
process.env.ROCKET1000_DEMO_ACCOUNT_LOGIN = "123456";
process.env.ROCKET1000_ALLOWED_SYMBOL = "EURUSD";
process.env.ROCKET1000_ENABLE_DEMO_SIGNALS = "true";
process.env.OPENAI_API_KEY = "fake-test-key-not-used";
process.env.ROCKET1000_STATE_PATH = join(dir, "state.json");

const { createServer } = await import("../src/server.mjs");

function snapshot() {
  const now = Math.floor(Date.now() / 1000);
  const bar = Math.floor(now / 900) * 900 - 900;
  return {
    accountMode: "DEMO", accountLogin: 123456, symbol: "EURUSD", timeframe: "M15",
    balance: 10000, equity: 10000, bid: 1.1077, ask: 1.10782,
    point: 0.00001, spreadPoints: 12, openPositions: 0, pendingOrders: 0,
    marketServerTime: now,
    candles: Array.from({ length: 40 }, (_, i) => {
      const close = 1.1 + i * 0.0002;
      return { time: bar - (39 - i) * 900, open: close - 0.0001,
        high: close + 0.0003, low: close - 0.0003, close };
    })
  };
}

test("authenticated demo signal, independent gating, and closed-bar dedupe", async () => {
  const nativeFetch = global.fetch;
  let aiCalls = 0;
  global.fetch = async (url) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    aiCalls++;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ content: [{ type: "output_text", text: JSON.stringify({
        action: "BUY", confidence: 0.94, reason: "Trend aligned on closed M15 bars"
      }) }] }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const server = createServer();
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/api/mt5/signal`;
    const body = JSON.stringify(snapshot());
    const unauth = await nativeFetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body
    });
    assert.equal(unauth.status, 401);

    async function send(s) {
      const r = await nativeFetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.ROCKET1000_EA_TOKEN}`,
          "content-type": "application/json" },
        body: JSON.stringify(s)
      });
      assert.equal(r.status, 200);
      return await r.json();
    }
    const live = snapshot(); live.accountMode = "REAL";
    assert.equal((await send(live)).action, "WAIT");
    const result = await send(snapshot());
    assert.equal(result.action, "BUY");
    assert.equal(result.model, "gpt-6.1-sol");
    const duplicate = await send(snapshot());
    assert.equal(duplicate.action, "WAIT");
    assert.equal(aiCalls, 1);
  } finally {
    global.fetch = nativeFetch;
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
