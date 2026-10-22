import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  market,
  terminal,
  approveFixtureLive,
  seedAnalysisEngineFixture,
} from "./helpers.mjs";
import { tradingService } from "../server/trading.mjs";
import { automationService, automaticIntent } from "../server/automation.mjs";
import { MODEL } from "../server/ai-analysis.mjs";
import { adaptiveProfile } from "../server/market.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { enqueueCommand, tradeContext } from "../server/trading.mjs";
import {
  validateTradeSettings,
  accountKey,
} from "../server/trade-settings.mjs";
const execution = {
  engineVersion: ENGINE_VERSION,
  tickSize: 0.01,
  tickValue: 1,
  point: 0.01,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 10,
  stopLevel: 10,
  freezeLevel: 5,
  dayStartEquity: 18432.81,
  dailyLoss: 7.18,
  peakEquity: 18432.81,
  existingRisk: 0,
  freeMargin: 18000,
  pendingOrders: 0,
  tradeAllowed: true,
  stopsVerified: true,
  newsVerified: true,
  newsBlocked: false,
  terminalId: "0123456789abcdef01234567",
  realizedToday: -7.18,
};
function assessment(
  s,
  decision = "BUY",
  timestamp = s.timestamp,
  overrides = {},
) {
  const entry = decision === "BUY" ? s.ask : s.bid;
  const sign = decision === "BUY" ? 1 : -1;
  return {
    model: MODEL,
    engineVersion: ENGINE_VERSION,
    symbol: s.symbol,
    decision,
    strategy: decision === "WAIT" ? "wait" : "trend",
    timeframe: "M1",
    confidence: 0.9,
    entryPrice: decision === "WAIT" ? null : entry,
    stopLoss: decision === "WAIT" ? null : entry - sign * 5,
    takeProfit: decision === "WAIT" ? null : entry + sign * 10,
    reasoning:
      "Deterministic analyzer fixture; no provider or broker is contacted.",
    risks: ["Fixture only"],
    proposedLots: decision === "WAIT" ? null : 1,
    entryAction:
      decision === "WAIT" ? "NONE" : s.positions.length ? "ADD" : "OPEN",
    positionActions: s.positions
      .filter((p) => p.managed)
      .map((p) =>
        decision !== "WAIT" && p.side !== decision
          ? {
              kind: "CLOSE",
              position: p.ticket,
              volume: null,
              stopLoss: null,
              takeProfit: null,
              reasoning: "Explicit fixture AI exit.",
            }
          : {
              kind: "MODIFY",
              position: p.ticket,
              volume: null,
              stopLoss: Math.max(p.stop, s.bid - 5),
              takeProfit: p.takeProfit,
              reasoning: "Explicit fixture AI protection.",
            },
      ),
    profile: adaptiveProfile(s),
    responseId: "resp_fixture_not_a_provider_call",
    analyzedAt: timestamp,
    marketTimestamp: s.timestamp,
    expiresAt: s.timestamp + 60000,
    executionApproved: false,
    ...overrides,
  };
}
// Only tests specifically about existing Live consent get prior Demo acceptance.
// This database fixture is not evidence of a real terminal execution test.
async function fixtureDemoAcceptance(f) {
  await f.db.query(
    "INSERT INTO rocket_engine_validation(user_id,engine_version,completed_at,evidence) VALUES(?,?,?,?)",
    ["alice", ENGINE_VERSION, f.now(), JSON.stringify({ fixtureOnly: true })],
  );
}
async function setup(type = "demo", customAnalyzer) {
  const f = await fixture();
  let identity = { ...terminal, accountType: type },
    snapshot = market(f.now()),
    session = "abcdef0123456789abcdef01",
    next = "BUY",
    calls = 0;
  const analyzer =
    customAnalyzer ||
    (async (s) => {
      calls++;
      return assessment(s, next, f.now());
    });
  const trade = tradingService(f.db, { now: f.now }),
    auto = automationService(f.db, { now: f.now, analyzer });
  const input = (patch = {}) => ({
    ...identity,
    eaProtocol: 4,
    terminalSession: session,
    execution,
    market: {
      ...snapshot,
      timestamp: f.now(),
      brokerTimestamp: f.now(),
      quoteTimestamp: f.now(),
      bars: market(f.now()).bars,
      timeframes: market(f.now()).timeframes,
    },
    ...patch,
  });
  const send = async (patch = {}, register = false, options = {}) => {
    await f.db.query(
      "UPDATE rocket_engine_scheduler SET last_seen=? WHERE id='fixture'",
      [f.now()],
    );
    return f.service.telemetry(f.token, input(patch), register, options);
  };
  await send({}, true);
  await seedAnalysisEngineFixture(f);
  const status = () => trade.status("alice");
  const start = async () =>
    trade.act("alice", {
      action: "start-auto",
      confirmation: "ENABLE DEMO 12345678",
      accountKey: (await status()).accountKey,
    });
  const consent = () => approveFixtureLive(trade);
  const authorize = (c) =>
    send({ authorization: { id: c.orderId, lease: c.lease } }, false, {
      authorize: true,
    });
  const ack = (c, patch = {}) =>
    send({
      orderResult: {
        id: c.orderId,
        lease: c.lease,
        status: "executed",
        retcode: 10009,
        deal: c.kind === "MODIFY" ? "0" : "9007199254740993123",
        order: "9007199254740993124",
        filledVolume: c.kind === "MODIFY" ? 0 : c.volume,
        filledPrice: c.kind === "MODIFY" ? 0 : c.entry,
        ...patch,
      },
    });
  return {
    ...f,
    trade,
    auto,
    input,
    send,
    status,
    start,
    consent,
    authorize,
    ack,
    snapshot: (patch) => {
      snapshot = { ...snapshot, ...patch };
    },
    signal: (value) => {
      next = value;
    },
    calls: () => calls,
    switchAccount: async (patch) => {
      identity = { ...identity, ...patch };
      session = "1234567890abcdef12345678";
      await send({}, true);
    },
  };
}
function position(c, patch = {}) {
  return {
    ticket: "9007199254740993666",
    identifier: "9007199254740993667",
    magic: 100061,
    comment: "R1000:" + c.orderId.slice(0, 24),
    ownedIntegrity: true,
    symbol: c.symbol,
    side: c.side,
    volume: c.volume,
    open: c.entry,
    stop: c.stop,
    takeProfit: c.takeProfit,
    profit: 2,
    ...patch,
  };
}
test("Demo automation uses the real broker command path for OPEN, tighten-SL MODIFY and opposite-signal CLOSE; fixtures never contact a broker", async () => {
  const f = await setup();
  try {
    await f.start();
    const [first, second] = await Promise.all([
      f.auto.cycle(f.token.split(".")[1]),
      f.auto.cycle(f.token.split(".")[1]),
    ]);
    assert.equal(f.calls(), 1);
    assert.ok([first.state, second.state].includes("queued"));
    let c = await f.send();
    assert.equal(c.command, "TRADE");
    assert.equal(c.kind, "OPEN");
    assert.equal(c.accountType, "demo");
    assert.equal(c.liveConfirmed, false);
    assert.ok(
      c.volume > 0.01,
      "default automatic sizing must not retain the old fixed 0.01 cap",
    );
    assert.ok(
      c.riskAmount <=
        Math.min(f.input().market.balance, f.input().market.equity) * 0.005 +
          1e-8,
    );
    assert.equal(c.riskPerTradePct, 0.5);
    await f.authorize(c);
    let p = position(c);
    f.snapshot({ positions: [p] });
    await f.ack(c);
    assert.equal((await f.status()).positions[0].managed, true);
    f.advance(60001);
    f.snapshot({ bid: 2102, ask: 2102.2 });
    await f.send();
    assert.equal((await f.auto.cycle(f.token.split(".")[1])).state, "queued");
    c = await f.send();
    assert.equal(c.kind, "MODIFY");
    assert.ok(c.stop > p.stop);
    assert.equal(c.position, p.ticket);
    await f.authorize(c);
    p = { ...p, stop: c.stop };
    f.snapshot({ positions: [p] });
    await f.ack(c);
    f.advance(300000);
    f.signal("SELL");
    await f.send();
    assert.equal((await f.auto.cycle(f.token.split(".")[1])).state, "queued");
    c = await f.send();
    assert.equal(c.kind, "CLOSE");
    assert.equal(c.side, "BUY");
    await f.authorize(c);
    f.snapshot({ positions: [] });
    await f.ack(c);
    await f.auto.cycle(f.token.split(".")[1]);
    assert.equal((await f.send()).command, "NONE");
    assert.equal((await f.status()).orders.length, 3);
    f.advance(300000);
    await f.send();
    await f.auto.cycle(f.token.split(".")[1]);
    c = await f.send();
    assert.equal(c.kind, "OPEN");
    assert.equal(c.side, "SELL");
  } finally {
    await f.db.close();
  }
});
test("Live automation cannot start without explicit consent for the exact login AND broker", async () => {
  const f = await setup("live");
  try {
    await fixtureDemoAcceptance(f);
    await assert.rejects(f.start(), /explicit confirmation/);
    await assert.rejects(
      f.trade.act("alice", {
        action: "confirm-live",
        accountKey: accountKey("wrong", "Broker-Live", "live"),
        confirmation: "ENABLE LIVE 12345678",
      }),
    );
    await f.consent();
    await f.start();
    assert.equal((await f.status()).automation.state, "running");
    await f.switchAccount({ brokerServer: "Different-Live" });
    assert.equal((await f.status()).liveConfirmed, false);
    assert.equal((await f.status()).automation.state, "stopped");
    await assert.rejects(f.start(), /explicit confirmation/);
    await f.switchAccount({ accountType: "demo", brokerServer: "Broker-Demo" });
    assert.equal((await f.status()).liveConfirmed, false);
    await f.start();
    await f.switchAccount({ accountType: "live", brokerServer: "Broker-Live" });
    assert.equal((await f.status()).liveConfirmed, false);
    assert.equal((await f.status()).automation.state, "stopped");
    await assert.rejects(f.start(), /explicit confirmation/);
    await f.consent();
    assert.equal((await f.status()).liveConfirmed, true);
  } finally {
    await f.db.close();
  }
});
test("switching Demo to Live stops the run and rejects an old claimed command even if the terminal reuses its old session nonce", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.auto.cycle(f.token.split(".")[1]);
    const old = await f.send();
    assert.equal(old.command, "TRADE");
    const next = {
      accountType: "live",
      brokerServer: "Broker-Live-New",
      accountLogin: "22222222",
    };
    await f.send(next, true);
    const state = await f.status();
    assert.equal(state.account.type, "live");
    assert.equal(state.automation.state, "stopped");
    assert.equal(state.liveConfirmed, false);
    assert.equal(state.orders.length, 0);
    await fixtureDemoAcceptance(f);
    await approveFixtureLive(f.trade);
    await f.trade.act("alice", {
      action: "start-auto",
      confirmation: "ENABLE DEMO 12345678",
      accountKey: state.accountKey,
    });
    await assert.rejects(
      f.send(
        { ...next, authorization: { id: old.orderId, lease: old.lease } },
        false,
        { authorize: true },
      ),
      /lease/,
    );
  } finally {
    await f.db.close();
  }
});
test("an actual open position is manageable only when its immutable originating command belongs to this account and it has no manual-deal contamination", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.auto.cycle(f.token.split(".")[1]);
    const c = await f.send();
    await f.authorize(c);
    const p = position(c);
    f.snapshot({ positions: [p] });
    await f.ack(c);
    let r = await f.trade.act("alice", {
      action: "preview",
      order: { kind: "CLOSE", position: p.ticket },
    });
    assert.equal(r.order.kind, "CLOSE");
    f.snapshot({ positions: [{ ...p, ownedIntegrity: false }] });
    await f.send();
    await assert.rejects(
      f.trade.act("alice", {
        action: "preview",
        order: { kind: "CLOSE", position: p.ticket },
      }),
      /Only positions/,
    );
    f.snapshot({ positions: [{ ...p, comment: "manual", magic: 0 }] });
    await f.send();
    await assert.rejects(
      f.trade.act("alice", {
        action: "preview",
        order: {
          kind: "MODIFY",
          position: p.ticket,
          stop: 2098,
          takeProfit: 2111,
        },
      }),
      /Only positions/,
    );
  } finally {
    await f.db.close();
  }
});
for (const method of [
  "stop",
  "reconnect",
  "switch",
  "revoke",
  "settings",
  "mode",
  "sizing",
])
  test(`${method} during AI inference cannot enqueue an order`, async () => {
    let release, started;
    const waiting = new Promise((resolve) => (started = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    const f = await setup("demo", async (s) => {
      started();
      await gate;
      return assessment(s, "BUY", f.now());
    });
    try {
      await f.start();
      const run = f.auto.cycle(f.token.split(".")[1]);
      await waiting;
      if (method === "stop") await f.service.stop("alice");
      if (method === "reconnect") await f.send({}, true);
      if (method === "switch")
        await f.switchAccount({
          accountLogin: "22222222",
          brokerServer: "Other-Demo",
        });
      if (method === "revoke") await f.service.revoke("alice", f.id);
      if (method === "settings")
        await f.trade.act("alice", {
          action: "settings",
          settings: { lotSize: 0.02 },
        });
      if (method === "mode")
        await f.trade.act("alice", {
          action: "settings",
          settings: { tradingMode: "aggressive" },
        });
      if (method === "sizing")
        await f.trade.act("alice", {
          action: "settings",
          settings: { sizingMode: "capped", lotSize: 0.01 },
        });
      release();
      await run;
      assert.equal((await f.status()).orders.length, 0);
      assert.equal((await f.status()).automation.state, "stopped");
    } finally {
      release();
      await f.db.close();
    }
  });

test("an optional saved cap limits the automatic broker command after a fresh start", async () => {
  const f = await setup();
  try {
    await f.trade.act("alice", {
      action: "settings",
      settings: { sizingMode: "capped", lotSize: 0.01 },
    });
    await f.start();
    assert.equal((await f.auto.cycle(f.token.split(".")[1])).state, "queued");
    const c = await f.send();
    assert.equal(c.kind, "OPEN");
    assert.equal(c.volume, 0.01);
    assert.equal(c.maxLots, 0.01);
    const authorized = await f.authorize(c);
    assert.equal(authorized.command, "AUTHORIZED");
    assert.equal(authorized.volume, 0.01);
  } finally {
    await f.db.close();
  }
});
for (const decision of ["WAIT", "LOW", "WRONG"])
  test(`${decision} model assessment does not submit a trade`, async () => {
    const f = await setup("demo", async (s) =>
      assessment(s, decision === "WAIT" ? "WAIT" : "BUY", s.timestamp, {
        model: decision === "WRONG" ? "gpt-other" : MODEL,
        confidence: decision === "LOW" ? 0.5 : 0.9,
      }),
    );
    try {
      await f.start();
      await f.auto.cycle(f.token.split(".")[1]);
      assert.equal((await f.status()).orders.length, 0);
    } finally {
      await f.db.close();
    }
  });
test("provider failure pauses automatic trading instead of generating a fallback or repeated billable requests", async () => {
  let calls = 0;
  const f = await setup("demo", async () => {
    calls++;
    throw Error("private-provider-response");
  });
  try {
    await f.start();
    await f.auto.cycle(f.token.split(".")[1]);
    await f.auto.cycle(f.token.split(".")[1]);
    const s = await f.status();
    assert.equal(calls, 1);
    assert.equal(s.automation.state, "stopped");
    assert.ok(!JSON.stringify(s).includes("private-provider-response"));
    assert.equal(s.orders.length, 0);
  } finally {
    await f.db.close();
  }
});
test("saved risk changes stop a running session, and lower daily limits stop new orders without a model call", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.trade.act("alice", {
      action: "settings",
      settings: { maxDailyLossPct: 0.1, lotSize: 0.02, stopLossPoints: 700 },
    });
    assert.equal((await f.status()).automation.state, "stopped");
    await f.send({ execution: { ...execution, dailyLoss: 20 } });
    await f.start();
    assert.equal(
      (await f.auto.cycle(f.token.split(".")[1])).state,
      "risk-stopped",
    );
    assert.equal(f.calls(), 0);
    assert.equal((await f.status()).orders.length, 0);
    for (const patch of [
      { maxDailyLossPct: 6 },
      { riskPerTradePct: 2 },
      { lotSize: -1 },
      { intervalSeconds: 0 },
      { masterKey: "bad" },
    ])
      assert.throws(() => validateTradeSettings(patch));
  } finally {
    await f.db.close();
  }
});
test("an ambiguous submitted order reconciles from broker history without ever being reissued", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.auto.cycle(f.token.split(".")[1]);
    const c = await f.send();
    await f.authorize(c);
    f.advance(45001);
    const reconcile = await f.send();
    assert.equal(reconcile.command, "RECONCILE");
    assert.equal(reconcile.orderId, c.orderId);
    assert.notEqual(reconcile.lease, c.lease);
    await f.ack(reconcile, {
      retcode: 0,
      reconciled: true,
      evidence: "broker-history",
    });
    const saved = (await f.status()).orders[0];
    assert.equal(saved.status, "executed");
    assert.equal(saved.result.evidence, "broker-history");
    assert.equal(saved.result.retcode, 0);
    await f.auto.cycle(f.token.split(".")[1]);
    assert.equal((await f.status()).orders.length, 1);
  } finally {
    await f.db.close();
  }
});

test("a recent manual analysis delays automation without pausing or spending again", async () => {
  const f = await setup();
  try {
    await f.db.query(
      "INSERT INTO rocket_analyses(id,connection_id,installation_id,status,created_at) VALUES(?,?,?,?,?)",
      ["manual", f.id, f.token.split(".")[1], "completed", f.now()],
    );
    await f.start();
    assert.equal(
      (await f.auto.cycle(f.token.split(".")[1])).state,
      "waiting-analysis-interval",
    );
    assert.equal(f.calls(), 0);
    assert.equal((await f.status()).automation.state, "running");
    f.advance(60001);
    await f.send();
    assert.equal((await f.auto.cycle(f.token.split(".")[1])).state, "queued");
    assert.equal(f.calls(), 1);
  } finally {
    await f.db.close();
  }
});

test("manual Live permission rejects approval for the same login at a different broker", async () => {
  const f = await setup("live");
  try {
    await fixtureDemoAcceptance(f);
    const oldKey = (await f.status()).accountKey;
    await f.switchAccount({ brokerServer: "Other-Live" });
    await assert.rejects(
      f.trade.act("alice", {
        action: "enable",
        confirmation: "ENABLE LIVE 12345678",
        accountKey: oldKey,
      }),
      /account changed/,
    );
    assert.equal((await f.status()).liveConfirmed, false);
    const current = await f.status();
    await approveFixtureLive(f.trade);
    await f.trade.act("alice", {
      action: "enable",
      confirmation: "ENABLE LIVE 12345678",
      accountKey: current.accountKey,
    });
    assert.equal((await f.status()).liveConfirmed, true);
  } finally {
    await f.db.close();
  }
});

test("an assessment from the previous closed candle is discarded before execution", async () => {
  let release, begun;
  const gate = new Promise((r) => (release = r)),
    entered = new Promise((r) => (begun = r));
  const f = await setup("demo", async (s) => {
    begun();
    await gate;
    return assessment(s, "BUY", f.now());
  });
  try {
    await f.start();
    const run = f.auto.cycle(f.token.split(".")[1]);
    await entered;
    f.advance(300000);
    await f.send();
    release();
    assert.equal((await run).state, "discarded");
    assert.equal((await f.status()).orders.length, 0);
    const [a] = await f.db.query(
      "SELECT lease_until FROM rocket_automation WHERE connection_id=?",
      [f.id],
    );
    assert.equal(Number(a.lease_until), 0);
  } finally {
    release();
    await f.db.close();
  }
});

test("trailing protection waits when the unchanged target enters the broker freeze distance", () => {
  assert.equal(
    automaticIntent(
      {
        settings: { trailingStopPoints: 100, minConfidence: 0.75 },
        execution,
        market: {
          symbol: "XAUUSD",
          bid: 2100,
          ask: 2100.2,
          positions: [
            {
              managed: true,
              ticket: "1",
              symbol: "XAUUSD",
              side: "BUY",
              stop: 2090,
              takeProfit: 2100.05,
            },
          ],
        },
      },
      null,
    ),
    null,
  );
});

for (const kind of ["MODIFY", "PARTIAL_CLOSE", "CLOSE"])
  test(`explicit AI ${kind} proposal traverses authenticated command, authorization and broker acknowledgement boundaries without real broker calls`, async () => {
    let phase = "OPEN",
      own;
    const f = await setup("demo", async (s) =>
      assessment(
        s,
        phase === "OPEN" ? "BUY" : "WAIT",
        s.timestamp,
        phase === "OPEN"
          ? {}
          : {
              proposedLots: null,
              entryAction: "NONE",
              positionActions: [
                {
                  kind,
                  position: own.ticket,
                  volume: kind === "PARTIAL_CLOSE" ? 0.01 : null,
                  stopLoss: kind === "MODIFY" ? 2097 : null,
                  takeProfit: kind === "MODIFY" ? 2110.2 : null,
                  reasoning:
                    "Explicit AI position-action fixture, no provider contacted.",
                },
              ],
            },
      ),
    );
    try {
      await f.start();
      await f.auto.cycle(f.token.split(".")[1]);
      const first = await f.send();
      await f.authorize(first);
      own = position(first);
      f.snapshot({ positions: [own] });
      await f.ack(first);
      phase = kind;
      f.advance(60001);
      await f.send();
      assert.equal((await f.auto.cycle(f.token.split(".")[1])).state, "queued");
      const command = await f.send();
      assert.equal(command.kind, kind === "MODIFY" ? "MODIFY" : "CLOSE");
      assert.equal(command.source, "ai");
      assert.ok(command.analysisId);
      assert.equal(command.position, own.ticket);
      assert.equal(command.positionVolume, own.volume);
      if (kind === "PARTIAL_CLOSE") {
        assert.equal(command.volume, 0.01);
        assert.equal(command.partialClose, true);
      }
      await f.authorize(command);
      f.snapshot({
        positions:
          kind === "CLOSE"
            ? []
            : [
                {
                  ...own,
                  volume:
                    kind === "PARTIAL_CLOSE" ? own.volume - 0.01 : own.volume,
                  stop: kind === "MODIFY" ? command.stop : own.stop,
                },
              ],
      });
      await f.ack(command);
      await f.auto.cycle(f.token.split(".")[1]);
      assert.equal(
        (await f.send()).command,
        "NONE",
        "one AI action must not repeat after its acknowledgement",
      );
      assert.equal((await f.status()).orders.length, 2);
      assert.equal(
        (await f.status()).orders.find((o) => o.id === command.orderId).status,
        "executed",
      );
    } finally {
      await f.db.close();
    }
  });

test("automatic management without stored AI authority is rejected even when a deterministic stop change is protective", async () => {
  const f = await setup();
  try {
    await f.start();
    await f.auto.cycle(f.token.split(".")[1]);
    const first = await f.send();
    await f.authorize(first);
    const p = position(first);
    f.snapshot({ positions: [p] });
    await f.ack(first);
    await assert.rejects(
      f.db.transaction(async (tx) =>
        enqueueCommand(
          tx,
          await tradeContext(tx, f.id, f.now()),
          {
            kind: "MODIFY",
            position: p.ticket,
            stop: 2097,
            takeProfit: p.takeProfit,
          },
          "invented-protective-rule",
          f.now(),
        ),
      ),
      /explicit Rocket1000 AI plan/,
    );
    assert.equal((await f.status()).orders.length, 1);
  } finally {
    await f.db.close();
  }
});
