import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  market,
  terminal,
  approveFixtureLive,
  seedAiEntryFixture,
} from "./helpers.mjs";
import {
  tradingService,
  validateExecution,
  tradeContext,
  enqueueCommand,
} from "../server/trading.mjs";
import { decisionBar } from "../server/market.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
const execution = {
  engineVersion: ENGINE_VERSION,
  terminalId: "0123456789abcdef01234567",
  tickSize: 0.01,
  tickValue: 1,
  point: 0.01,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 10,
  stopLevel: 10,
  dayStartEquity: 18432.81,
  dailyLoss: 7.18,
  peakEquity: 18432.81,
  existingRisk: 0,
  freeMargin: 18000,
  pendingOrders: 0,
  tradeAllowed: true,
  stopsVerified: true,
  costsVerified: true,
  commissionPerLot: 0,
  consecutiveLosses: 0,
  consecutiveLossesVerified: true,
  newsVerified: true,
  newsBlocked: false,
};
async function setup(type = "demo", { qualified = false } = {}) {
  const f = await fixture(),
    trade = tradingService(f.db, { now: f.now });
  const input = (patch = {}) => ({
    ...terminal,
    accountType: type,
    eaProtocol: 4,
    terminalSession: "0123456789abcdef01234567",
    market: market(f.now()),
    execution,
    ...patch,
  });
  const send = (patch = {}, register = false, options = {}) =>
    f.service.telemetry(f.token, input(patch), register, options);
  await send({}, true);
  await seedAiEntryFixture(f);
  if (qualified) {
    // Explicit in-memory test evidence only. Real qualification can only come
    // from credential-verified Demo broker acknowledgements in production.
    assert.equal(type, "live");
    await f.db.query(
      "INSERT INTO rocket_engine_validation(user_id,engine_version,completed_at,evidence) VALUES(?,?,?,?)",
      [
        "alice",
        ENGINE_VERSION,
        f.now(),
        JSON.stringify({
          fixtureOnly: true,
          purpose: "Legacy Live-consent unit coverage",
        }),
      ],
    );
  }
  const enable = async () => {
    if (type === "live") await approveFixtureLive(trade);
    return trade.act("alice", {
      action: "enable",
      accountKey: (await trade.status("alice")).accountKey,
      confirmation: `ENABLE ${type.toUpperCase()} ${terminal.accountLogin}`,
    });
  };
  const preview = async () => {
    await seedAiEntryFixture(f);
    return trade.act("alice", {
      action: "preview",
      order: {
        side: "BUY",
        symbol: "XAUUSD",
        stop: 2095.2,
        takeProfit: 2110.2,
        maxLots: 0.01,
      },
    });
  };
  const confirm = (id) =>
    trade.act("alice", { action: "confirm", previewId: id });
  return { ...f, trade, send, input, enable, preview, confirm };
}
test("broker metadata rejects missing, negative and non-finite values and strips extra secrets", () => {
  for (const patch of [
    { tickValue: 0 },
    { dailyLoss: -1 },
    { tradeAllowed: 1 },
    { pendingOrders: 0.5 },
    { peakEquity: NaN },
  ])
    assert.throws(() => validateExecution({ ...execution, ...patch }));
  assert.equal(
    validateExecution({ ...execution, credential: "secret" }).credential,
    undefined,
  );
});
for (const type of ["demo", "live"])
  test(`${type}: explicit enable, immutable review, one claim, one authorization and a verified deal acknowledgement`, async () => {
    const f = await setup(type, { qualified: type === "live" });
    try {
      assert.equal((await f.trade.status("alice")).enabled, false);
      await assert.rejects(f.preview(), /enable orders/);
      await assert.rejects(
        f.trade.act("alice", {
          action: "enable",
          accountKey: "wrong-account",
        }),
        /account changed/,
      );
      await f.enable();
      const review = await f.preview();
      assert.equal(review.order.volume, 0.01);
      const requests = await Promise.all([
        f.confirm(review.id),
        f.confirm(review.id),
      ]);
      assert.equal(requests[0].id, requests[1].id);
      const [command, duplicate] = await Promise.all([f.send(), f.send()]);
      assert.equal(command.command, "TRADE");
      assert.equal(duplicate.command, "NONE");
      await assert.rejects(
        f.send(
          { authorization: { id: command.orderId, lease: "x".repeat(43) } },
          false,
          { authorize: true },
        ),
        /lease/,
      );
      const auth = await f.send(
        { authorization: { id: command.orderId, lease: command.lease } },
        false,
        { authorize: true },
      );
      assert.equal(auth.command, "AUTHORIZED");
      await assert.rejects(
        f.send(
          { authorization: { id: command.orderId, lease: command.lease } },
          false,
          { authorize: true },
        ),
        /lease/,
      );
      const result = {
        id: command.orderId,
        lease: command.lease,
        status: "executed",
        retcode: 10009,
        deal: "9007199254740993123",
        order: "9007199254740993124",
        filledPrice: command.entry,
        filledVolume: command.volume,
      };
      await assert.rejects(
        f.send({ orderResult: { ...result, deal: "0" } }),
        /deal/,
      );
      await f.send({ orderResult: result });
      await f.send({ orderResult: result });
      const [saved] = (await f.trade.status("alice")).orders;
      assert.equal(saved.status, "executed");
      assert.equal(saved.result.deal, result.deal);
    } finally {
      await f.db.close();
    }
  });
test("another browser workspace cannot enable, review, confirm or inspect this account", async () => {
  const f = await setup();
  try {
    await f.enable();
    const r = await f.preview();
    await assert.rejects(f.trade.status("bob"), /Connect MT5/);
    await f.service.create("bob");
    await assert.rejects(
      f.trade.act("bob", { action: "confirm", previewId: r.id }),
      /expired/,
    );
    assert.equal((await f.trade.status("bob")).account, null);
    assert.equal((await f.trade.status("bob")).orders.length, 0);
  } finally {
    await f.db.close();
  }
});
for (const label of [
  "reconnect",
  "new session",
  "revoke",
  "rotation",
  "stop",
  "account mismatch",
  "expired policy",
])
  test(`${label} prevents a queued order from being authorized`, async () => {
    const f = await setup();
    try {
      await f.enable();
      const r = await f.preview();
      await f.confirm(r.id);
      const c = await f.send();
      assert.equal(c.command, "TRADE");
      if (label === "reconnect") await f.send({}, true);
      if (label === "new session")
        await f.send({ terminalSession: "abcdef0123456789abcdef01" });
      if (label === "revoke") await f.service.revoke("alice", f.id);
      if (label === "rotation") {
        await f.service.revoke("alice", f.id);
        await f.download();
      }
      if (label === "stop") await f.service.stop("alice");
      if (label === "account mismatch")
        await assert.rejects(
          f.send({ accountLogin: "87654321" }),
          /authorized/,
        );
      if (label === "expired policy") f.advance(900001);
      await assert.rejects(
        f.send({ authorization: { id: c.orderId, lease: c.lease } }, false, {
          authorize: true,
        }),
      );
      assert.equal((await f.trade.status("alice")).enabled, false);
    } finally {
      await f.db.close();
    }
  });
test("expired reviews, changed prices, invalid stops and same-symbol averaging are rejected", async () => {
  const f = await setup();
  try {
    await f.enable();
    let r = await f.preview();
    f.advance(30001);
    await f.send();
    await assert.rejects(f.confirm(r.id), /expired/);
    r = await f.preview();
    await f.send({
      market: { ...market(f.now()), bid: 2100.12, ask: 2100.32 },
    });
    await assert.rejects(
      f.confirm(r.id),
      /Price or risk|protective distances|AI proposal's entry tolerance/,
    );
    await f.send();
    await assert.rejects(
      f.trade.act("alice", {
        action: "preview",
        order: {
          side: "BUY",
          symbol: "XAUUSD",
          stop: 2101,
          takeProfit: 2110,
          maxLots: 0.01,
        },
      }),
      /Protective/,
    );
    await f.send({
      market: {
        ...market(f.now()),
        positions: [
          {
            symbol: "XAUUSD",
            side: "BUY",
            volume: 0.01,
            open: 2090,
            stop: 2080,
            takeProfit: 2110,
            profit: 10,
          },
        ],
      },
    });
    await assert.rejects(f.preview(), /Maximum 1|already exists/);
  } finally {
    await f.db.close();
  }
});
for (const [label, patch] of Object.entries({
  "EA permission off": { tradeAllowed: false },
  "news unavailable": { newsVerified: false },
  "news blackout": { newsBlocked: true },
  "unprotected position": { stopsVerified: false },
  "pending orders": { pendingOrders: 1 },
  "daily loss": { dailyLoss: 1000 },
  drawdown: { peakEquity: 21000 },
}))
  test(`cannot open when ${label}`, async () => {
    const f = await setup();
    try {
      await f.send({ execution: { ...execution, ...patch } });
      if (patch.tradeAllowed === false) await assert.rejects(f.enable());
      else {
        await f.enable();
        await assert.rejects(f.preview());
      }
      assert.equal((await f.trade.status("alice")).enabled, false);
    } finally {
      await f.db.close();
    }
  });
test("unknown broker outcome blocks new orders and is never automatically retried", async () => {
  const f = await setup();
  try {
    await f.enable();
    const r = await f.preview();
    await f.confirm(r.id);
    const c = await f.send();
    await f.send({ authorization: { id: c.orderId, lease: c.lease } }, false, {
      authorize: true,
    });
    f.advance(45001);
    await f.send();
    const s = await f.trade.status("alice");
    assert.equal(s.orders[0].status, "uncertain");
    assert.equal(s.enabled, false);
    await assert.rejects(f.enable(), /reconcil/);
    const reconciliation = await f.send();
    assert.equal(reconciliation.command, "RECONCILE");
    assert.equal(reconciliation.orderId, c.orderId);
    assert.equal((await f.trade.status("alice")).orders.length, 1);
  } finally {
    await f.db.close();
  }
});
test("old telemetry protocol can never receive orders and registration disables permission", async () => {
  const f = await setup();
  try {
    await f.enable();
    const r = await f.service.telemetry(
      f.token,
      { ...terminal, accountType: "demo", market: market(f.now()) },
      true,
    );
    assert.equal(r.command, "NONE");
    assert.equal(r.tradingEnabled, false);
    assert.equal((await f.trade.status("alice")).enabled, false);
  } finally {
    await f.db.close();
  }
});

test("browser-supplied AI provenance and oversized risk never become automatic execution evidence", async () => {
  const f = await setup();
  try {
    await f.enable();
    const injected = {
      side: "BUY",
      symbol: "XAUUSD",
      stop: 2095.2,
      takeProfit: 2110.2,
      maxLots: 10,
      source: "ai",
      analysisId: "invented-analysis",
      engineVersion: ENGINE_VERSION,
      signalExpiresAt: f.now() + 60000,
      signalBarTime: decisionBar(market(f.now())),
      signalStrategy: "trend",
      signalConfidence: 1,
      riskPercent: 100,
      volume: 10,
      liveConfirmed: true,
      demoValidated: true,
    };
    await assert.rejects(
      f.trade.act("alice", {
        action: "preview",
        order: injected,
      }),
      /exact AI proposal/,
    );
    const review = await f.trade.act("alice", {
      action: "preview",
      order: {
        kind: "OPEN",
        source: "ai",
        analysisId: "invented-analysis",
        riskPercent: 100,
        volume: 10,
        liveConfirmed: true,
        demoValidated: true,
      },
    });
    assert.ok(review.order.volume < 1);
    assert.equal(review.order.riskPercent, 0.25);
    assert.notEqual(review.order.analysisId, "invented-analysis");
    assert.ok(review.order.analysisId);
    assert.equal(review.order.source, "ai");
    assert.equal(review.order.manualReview, true);
    await f.confirm(review.id);
    const [saved] = await f.db.query(
      "SELECT payload FROM rocket_trade_commands WHERE preview_id=?",
      [review.id],
    );
    const payload = JSON.parse(saved.payload);
    assert.equal(payload.analysisId, review.order.analysisId);
    assert.equal(payload.source, "ai");
    assert.equal(payload.manualReview, true);
    assert.equal(payload.liveConfirmed, undefined);
    assert.equal(payload.demoValidated, undefined);
    assert.equal((await f.trade.status("alice")).demoValidation.passed, false);
  } finally {
    await f.db.close();
  }
});

test("automatic entries cannot manufacture a matching stored AI assessment with browser fields", async () => {
  const f = await setup();
  try {
    await f.enable();
    await assert.rejects(
      f.db.transaction(async (tx) => {
        const ctx = await tradeContext(tx, f.id, f.now());
        return enqueueCommand(
          tx,
          ctx,
          {
            kind: "OPEN",
            side: "BUY",
            symbol: "XAUUSD",
            stop: 2095.2,
            takeProfit: 2110.2,
            maxLots: 10,
            analysisId: "invented-analysis",
            source: "ai",
            engineVersion: ENGINE_VERSION,
            signalConfidence: 1,
          },
          "spoofed-automatic-entry",
          f.now(),
        );
      }),
      /fresh, explicit Rocket1000 AI plan/,
    );
    assert.equal((await f.trade.status("alice")).orders.length, 0);
  } finally {
    await f.db.close();
  }
});

test("browser review cannot invent a strategy entry without AI and a confirmed AI proposal cannot be reused", async () => {
  const f = await setup();
  try {
    await f.enable();
    await f.db.query("DELETE FROM rocket_analyses WHERE connection_id=?", [
      f.id,
    ]);
    await assert.rejects(
      f.trade.act("alice", { action: "preview", order: { kind: "OPEN" } }),
      (e) => e.code === "AI_PLAN_REQUIRED",
    );
    await seedAiEntryFixture(f);
    const review = await f.trade.act("alice", {
      action: "preview",
      order: { kind: "OPEN" },
    });
    await f.confirm(review.id);
    const c = await f.send();
    await f.send({ authorization: { id: c.orderId, lease: c.lease } }, false, {
      authorize: true,
    });
    await f.send({
      orderResult: {
        id: c.orderId,
        lease: c.lease,
        status: "executed",
        retcode: 10009,
        deal: "777",
        order: "778",
        filledVolume: c.volume,
        filledPrice: c.entry,
      },
    });
    await assert.rejects(
      f.trade.act("alice", { action: "preview", order: { kind: "OPEN" } }),
      (e) => e.code === "AI_PLAN_ALREADY_SUBMITTED",
    );
    assert.equal((await f.trade.status("alice")).orders.length, 1);
    assert.equal(
      (await f.trade.status("alice")).demoValidation.passed,
      false,
      "reviewed trades cannot qualify automatic Live execution",
    );
  } finally {
    await f.db.close();
  }
});

test("reviewed AI entries require a valid proposed price within the original AI entry tolerance", async () => {
  const f = await setup();
  try {
    await f.enable();
    for (const entryPrice of [null, 0, -1, 2100]) {
      await f.db.query("DELETE FROM rocket_analyses WHERE connection_id=?", [
        f.id,
      ]);
      await seedAiEntryFixture(f, { entryPrice });
      await assert.rejects(
        f.trade.act("alice", { action: "preview", order: { kind: "OPEN" } }),
        (e) => e.code === "AI_ENTRY_PRICE_CHANGED",
      );
    }
    assert.equal((await f.trade.status("alice")).orders.length, 0);
  } finally {
    await f.db.close();
  }
});

test("final authorization rejects drift beyond the AI entry even when drift from the user review remains allowed", async () => {
  const f = await setup();
  try {
    await f.enable();
    await f.db.query("DELETE FROM rocket_analyses WHERE connection_id=?", [
      f.id,
    ]);
    await seedAiEntryFixture(f, { entryPrice: 2100.15 });
    const review = await f.trade.act("alice", {
      action: "preview",
      order: { kind: "OPEN" },
    });
    await f.confirm(review.id);
    const c = await f.send();
    assert.equal(c.command, "TRADE");
    const nextMarket = { ...market(f.now()), ask: 2100.28 };
    assert.ok(
      Math.abs(nextMarket.ask - review.order.entry) <
        review.order.maxSlippage * execution.point,
    );
    await assert.rejects(
      f.send(
        {
          market: nextMarket,
          authorization: { id: c.orderId, lease: c.lease },
        },
        false,
        { authorize: true },
      ),
      (e) => e.code === "AI_ENTRY_PRICE_CHANGED",
    );
    const [saved] = await f.db.query(
      "SELECT status FROM rocket_trade_commands WHERE id=?",
      [c.orderId],
    );
    assert.equal(saved.status, "claimed");
  } finally {
    await f.db.close();
  }
});
