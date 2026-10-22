import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import {
  fixture,
  market,
  terminal,
  approveFixtureLive,
  seedAiEntryFixture,
} from "./helpers.mjs";
import { tradingService } from "../server/trading.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// Isolated protocol/security fixtures only. No AI provider or broker is called,
// and fixture qualification is never evidence of a real Demo acceptance test.
const SESSION = "0123456789abcdef01234567";
const execution = {
  engineVersion: ENGINE_VERSION,
  terminalId: "abcdef0123456789abcdef01",
  tickSize: 0.01,
  tickValue: 1,
  point: 0.01,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 10,
  stopLevel: 10,
  freezeLevel: 0,
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
};

async function qualifyFixture(f, uid = "alice") {
  await f.db.query(
    "INSERT INTO rocket_engine_validation(user_id,engine_version,completed_at,evidence) VALUES(?,?,?,?)",
    [
      uid,
      ENGINE_VERSION,
      f.now(),
      JSON.stringify({
        fixtureOnly: true,
        purpose: "Live activation protocol tests",
      }),
    ],
  );
}
async function setup({ type = "live", qualified = true } = {}) {
  const f = await fixture();
  let identity = { ...terminal, accountType: type },
    session = SESSION,
    token = f.token;
  const trade = tradingService(f.db, { now: f.now });
  const input = (patch = {}) => ({
    ...identity,
    eaProtocol: 4,
    terminalSession: session,
    execution,
    market: market(f.now()),
    ...patch,
  });
  const send = (patch = {}, register = false) =>
    f.service.telemetry(token, input(patch), register);
  await send({}, true);
  await seedAiEntryFixture(f, { stopLoss: 2095.2, takeProfit: 2110.2 });
  if (qualified) await qualifyFixture(f);
  const status = () => trade.status("alice");
  const prepare = async () =>
    trade.act("alice", {
      action: "prepare-live",
      accountKey: (await status()).accountKey,
    });
  const confirm = (approval, patch = {}, uid = "alice") =>
    trade.act(uid, {
      action: "confirm-live",
      approvalId: approval.approvalId,
      accountKey: approval.accountKey,
      confirmation: `ENABLE LIVE ${approval.account.login}`,
      acknowledgedRisk: true,
      ...patch,
    });
  return {
    ...f,
    trade,
    input,
    send,
    status,
    prepare,
    confirm,
    start: async () =>
      trade.act("alice", {
        action: "start-auto",
        confirmation: "ENABLE DEMO 12345678",
        accountKey: (await status()).accountKey,
      }),
    switch: async (patch = {}, newSession = session) => {
      identity = { ...identity, ...patch };
      session = newSession;
      await send({}, true);
    },
    rotate: async () => {
      token = await f.download();
      await send({}, true);
    },
  };
}

test("Live activation presents server-verified account/risk, consumes one approval and never starts orders", async () => {
  const f = await setup();
  try {
    const before = await f.status();
    assert.equal(before.liveConfirmed, false);
    const a = await f.prepare();
    assert.match(a.approvalId, /^[a-f0-9-]{36}$/);
    assert.equal(a.accountKey, before.accountKey);
    assert.deepEqual(a.account, {
      login: terminal.accountLogin,
      server: terminal.brokerServer,
      type: "live",
    });
    assert.equal(a.serverTime, f.now());
    assert.equal(a.expiresAt, f.now() + 60000);
    assert.ok(a.currentRiskPct > 0 && a.currentRiskPct <= 1);
    assert.equal(a.settings.maxDailyLossPct, before.settings.maxDailyLossPct);
    assert.equal(a.settings.maxDrawdownPct, before.settings.maxDrawdownPct);
    assert.equal(a.settings.maxPositions, before.settings.maxPositions);
    assert.equal((await f.status()).liveConfirmed, false);
    await f.confirm(a);
    const activated = await f.status();
    assert.equal(activated.liveConfirmed, true);
    assert.equal(activated.liveConfirmedAt, f.now());
    assert.equal(activated.permissionActive, false);
    assert.equal(activated.enabled, false);
    assert.equal(activated.orders.length, 0);
    assert.equal((await f.send()).command, "NONE");
    const [proof] = await f.db.query(
      "SELECT * FROM rocket_live_approvals WHERE id=?",
      [a.approvalId],
    );
    assert.equal(Number(proof.used_at), activated.liveConfirmedAt);
    assert.equal(proof.engine_version, ENGINE_VERSION);
    await assert.rejects(f.confirm(a), /approval|expired|already|activation/i);
    await f.start();
    assert.equal((await f.status()).automation.state, "running");
    assert.equal((await f.status()).orders.length, 0);
  } finally {
    await f.db.close();
  }
});

for (const [name, patch] of Object.entries({
  "missing approval": { approvalId: undefined },
  "invented approval": { approvalId: randomUUID() },
  "wrong account confirmation": { confirmation: "ENABLE LIVE 87654321" },
  "case-normalized confirmation": { confirmation: "enable live 12345678" },
  "unchecked risk acknowledgement": { acknowledgedRisk: false },
  "missing risk acknowledgement": { acknowledgedRisk: undefined },
  "string risk acknowledgement": { acknowledgedRisk: "true" },
  "wrong immutable account key": { accountKey: "f".repeat(64) },
})) {
  test(`Live activation rejects ${name} without granting execution`, async () => {
    const f = await setup();
    try {
      const a = await f.prepare();
      await assert.rejects(f.confirm(a, patch));
      assert.equal((await f.status()).liveConfirmed, false);
      assert.equal((await f.status()).permissionActive, false);
      assert.equal((await f.status()).orders.length, 0);
    } finally {
      await f.db.close();
    }
  });
}

test("concurrent confirmation consumes the one-time Live approval exactly once", async () => {
  const f = await setup();
  try {
    const a = await f.prepare();
    const attempts = await Promise.allSettled([f.confirm(a), f.confirm(a)]);
    assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((x) => x.status === "rejected").length, 1);
    assert.equal((await f.status()).liveConfirmed, true);
    assert.equal((await f.status()).permissionActive, false);
  } finally {
    await f.db.close();
  }
});

test("consumed Live proof remains valid after the review timeout while unused approvals expire", async () => {
  const f = await setup();
  try {
    await approveFixtureLive(f.trade);
    f.advance(60001);
    await f.send();
    assert.equal((await f.status()).liveConfirmed, true);
    assert.equal((await f.status()).permissionActive, false);
    await f.start();
    assert.equal((await f.status()).automation.state, "running");
  } finally {
    await f.db.close();
  }
});

test("only the most recently displayed Live review can activate the account", async () => {
  const f = await setup();
  try {
    const oldReview = await f.prepare();
    const currentReview = await f.prepare();
    assert.notEqual(oldReview.approvalId, currentReview.approvalId);
    await assert.rejects(f.confirm(oldReview));
    assert.equal((await f.status()).liveConfirmed, false);
    await f.confirm(currentReview);
    assert.equal((await f.status()).liveConfirmed, true);
  } finally {
    await f.db.close();
  }
});

for (const reason of [
  "expired",
  "account",
  "broker",
  "session",
  "settings",
  "token rotation",
  "engine",
  "server disabled",
]) {
  test(`a prepared Live approval cannot survive changed ${reason}`, async () => {
    const f = await setup();
    const previousDisable = process.env.ROCKET_DISABLE_LIVE_ORDERS;
    try {
      const a = await f.prepare();
      if (reason === "expired") {
        f.advance(60001);
        await f.send();
      }
      if (reason === "account") await f.switch({ accountLogin: "87654321" });
      if (reason === "broker") await f.switch({ brokerServer: "Other-Live" });
      if (reason === "session") await f.switch({}, "abcdef0123456789abcdef01");
      if (reason === "settings")
        await f.trade.act("alice", {
          action: "settings",
          settings: { maxDailyLossPct: 2 },
        });
      if (reason === "token rotation") await f.rotate();
      if (reason === "engine")
        await f.send({
          execution: { ...execution, engineVersion: "rocket-ai-old" },
        });
      if (reason === "server disabled")
        process.env.ROCKET_DISABLE_LIVE_ORDERS = "1";
      const current = await f.status();
      await assert.rejects(
        f.confirm(a, {
          accountKey: current.accountKey,
          confirmation: `ENABLE LIVE ${current.account.login}`,
        }),
      );
      assert.equal((await f.status()).liveConfirmed, false);
      assert.equal((await f.status()).permissionActive, false);
      assert.equal((await f.status()).orders.length, 0);
    } finally {
      if (previousDisable === undefined)
        delete process.env.ROCKET_DISABLE_LIVE_ORDERS;
      else process.env.ROCKET_DISABLE_LIVE_ORDERS = previousDisable;
      await f.db.close();
    }
  });
}

test("another verified workspace cannot consume a Live approval even for identical broker details", async () => {
  const f = await setup();
  try {
    const a = await f.prepare();
    const bob = await f.service.create("bob");
    const zip = unzipSync(await f.service.download("bob", bob.id));
    const token = strFromU8(
      zip["MQL5/Files/ROCKET1000/rocket1000.config"],
    ).match(/^credential=(.+)$/m)[1];
    await f.service.telemetry(token, f.input(), true);
    await qualifyFixture(f, "bob");
    assert.equal((await f.trade.status("bob")).accountKey, a.accountKey);
    await assert.rejects(f.confirm(a, {}, "bob"));
    assert.equal((await f.trade.status("bob")).liveConfirmed, false);
    await f.confirm(a);
    assert.equal((await f.status()).liveConfirmed, true);
  } finally {
    await f.db.close();
  }
});

test("manual ENABLE LIVE wording cannot create activation or any broker command", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.trade.act("alice", {
        action: "enable",
        accountKey: (await f.status()).accountKey,
        confirmation: "ENABLE LIVE 12345678",
      }),
    );
    assert.equal((await f.status()).liveConfirmed, false);
    assert.equal((await f.status()).permissionActive, false);
    assert.equal((await f.status()).orders.length, 0);
  } finally {
    await f.db.close();
  }
});

test("legacy persisted Live consent stays disabled even after current Demo qualification", async () => {
  const f = await setup();
  try {
    const state = await f.status();
    await f.db.query(
      "INSERT INTO rocket_live_consents(user_id,account_key,account_login,broker_server,confirmed_at) VALUES(?,?,?,?,?)",
      [
        "alice",
        state.accountKey,
        state.account.login,
        state.account.server,
        f.now(),
      ],
    );
    await f.db.query(
      "INSERT INTO rocket_trade_policy(connection_id,installation_id,session_id,expires_at) VALUES(?,?,?,?)",
      [f.id, f.token.split(".")[1], SESSION, f.now() + 900000],
    );
    await f.db.query(
      "UPDATE rocket_direct_connections SET stopped=0 WHERE id=?",
      [f.id],
    );
    assert.equal((await f.status()).liveConfirmed, false);
    assert.equal((await f.status()).permissionActive, false);
    assert.equal((await f.send()).tradingEnabled, false);
    await assert.rejects(f.start(), /confirmation|activation/i);
  } finally {
    await f.db.close();
  }
});

test("an approval from an obsolete engine cannot validate persisted Live consent", async () => {
  const f = await setup();
  try {
    const a = await approveFixtureLive(f.trade);
    await f.db.query(
      "UPDATE rocket_live_approvals SET engine_version=? WHERE id=?",
      ["rocket-ai-old", a.approvalId],
    );
    assert.equal((await f.status()).liveConfirmed, false);
    assert.equal((await f.send()).tradingEnabled, false);
  } finally {
    await f.db.close();
  }
});

for (const [name, patch] of Object.entries({
  "older protocol": { eaProtocol: 3 },
  "older engine": {
    execution: { ...execution, engineVersion: "rocket-ai-old" },
  },
  "missing terminal identity": { execution: { ...execution, terminalId: "" } },
})) {
  test(`an activated Live account cannot execute or manually enable with ${name}`, async () => {
    const f = await setup();
    try {
      await approveFixtureLive(f.trade);
      await f.start();
      if (name === "missing terminal identity") {
        await assert.rejects(f.send(patch), /persistent terminal identity/);
        // Represent a legacy persisted execution row. Current protocol-4
        // ingestion rejects this malformed data before it can be saved.
        await f.db.query(
          "UPDATE rocket_execution SET payload=? WHERE connection_id=?",
          [JSON.stringify({ ...execution, protocol: 4, terminalId: "" }), f.id],
        );
      } else {
        const response = await f.send(patch);
        assert.equal(response.tradingEnabled, false);
        assert.equal(response.command, "NONE");
      }
      const state = await f.status();
      assert.equal(state.liveConfirmed, true);
      assert.equal(state.permissionActive, false);
      await assert.rejects(
        f.trade.act("alice", {
          action: "enable",
          accountKey: state.accountKey,
          confirmation: "ENABLE LIVE 12345678",
        }),
        (e) => e.status === 409 && e.code === "LIVE_VERIFICATION_REQUIRED",
      );
      assert.equal((await f.status()).orders.length, 0);
    } finally {
      await f.db.close();
    }
  });
}

test("Demo remains testable without Live activation but cannot create a Live approval", async () => {
  const f = await setup({ type: "demo", qualified: false });
  try {
    await assert.rejects(f.prepare());
    assert.equal((await f.status()).demoValidation.passed, false);
    await f.start();
    assert.equal((await f.status()).automation.state, "running");
    assert.equal((await f.status()).liveConfirmed, false);
    assert.equal((await f.status()).permissionActive, true);
    assert.equal((await f.status()).orders.length, 0);
  } finally {
    await f.db.close();
  }
});

test("Live preparation requires current genuine Demo gate evidence, which no browser action can supply", async () => {
  const f = await setup({ qualified: false });
  try {
    await assert.rejects(
      f.prepare(),
      (e) => e.code === "DEMO_VALIDATION_REQUIRED",
    );
    await assert.rejects(
      f.trade.act("alice", {
        action: "mark-demo-complete",
        passed: true,
        engineVersion: ENGINE_VERSION,
      }),
    );
    assert.equal((await f.status()).demoValidation.passed, false);
    assert.equal((await f.status()).liveConfirmed, false);
  } finally {
    await f.db.close();
  }
});

for (const action of ["disable", "revoke-live", "emergency-stop"]) {
  test(`${action} revokes Live activation, cancels queued execution and invalidates pending approval`, async () => {
    const f = await setup();
    try {
      await approveFixtureLive(f.trade);
      await f.start();
      const review = await f.trade.act("alice", {
        action: "preview",
        order: {
          side: "BUY",
          symbol: "XAUUSD",
          stop: 2095.2,
          takeProfit: 2110.2,
          maxLots: 0.01,
        },
      });
      await f.trade.act("alice", { action: "confirm", previewId: review.id });
      const pending = await f.prepare();
      if (action === "emergency-stop") await f.service.stop("alice");
      else await f.trade.act("alice", { action });
      const state = await f.status();
      assert.equal(state.liveConfirmed, false);
      assert.equal(state.permissionActive, false);
      assert.equal(state.automation.state, "stopped");
      assert.equal(state.orders[0].status, "cancelled");
      assert.equal((await f.send()).command, "NONE");
      await assert.rejects(f.confirm(pending));
      assert.ok(state.activationEvents.length > 0);
    } finally {
      await f.db.close();
    }
  });
}

test("Emergency Stop clears saved activations for every Live account in this private workspace", async () => {
  const f = await setup();
  try {
    await approveFixtureLive(f.trade);
    await f.switch({ accountLogin: "87654321" });
    await approveFixtureLive(f.trade);
    assert.equal((await f.status()).liveConfirmed, true);
    await f.service.stop("alice");
    await f.switch({ accountLogin: terminal.accountLogin });
    assert.equal((await f.status()).liveConfirmed, false);
    assert.equal(
      (
        await f.db.query("SELECT * FROM rocket_live_consents WHERE user_id=?", [
          "alice",
        ])
      ).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});

test("Emergency Stop invalidates a pending first-time review even before trading was enabled", async () => {
  const f = await setup();
  try {
    const a = await f.prepare();
    assert.equal((await f.status()).permissionActive, false);
    await f.service.stop("alice");
    await assert.rejects(f.confirm(a));
    assert.equal((await f.status()).liveConfirmed, false);
    assert.equal((await f.status()).permissionActive, false);
    assert.equal((await f.status()).orders.length, 0);
  } finally {
    await f.db.close();
  }
});

test("Live confirmation atomically stops a persisted legacy run and cancels queued orders before recording activation", async () => {
  const f = await setup();
  try {
    const installation = f.token.split(".")[1];
    await f.db.query(
      "INSERT INTO rocket_trade_policy(connection_id,installation_id,session_id,expires_at) VALUES(?,?,?,?)",
      [f.id, installation, SESSION, f.now() + 900000],
    );
    await f.db.query(
      "INSERT INTO rocket_automation(connection_id,run_id,installation_id,session_id,state) VALUES(?,?,?,?,?)",
      [f.id, randomUUID(), installation, SESSION, "running"],
    );
    await f.db.query(
      "UPDATE rocket_direct_connections SET stopped=0 WHERE id=?",
      [f.id],
    );
    const commandId = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        commandId,
        randomUUID(),
        f.id,
        installation,
        SESSION,
        JSON.stringify({ kind: "OPEN", engineVersion: ENGINE_VERSION }),
        "queued",
        f.now(),
        f.now() + 45000,
      ],
    );
    await f.db.query(
      "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?) ON CONFLICT(command_id) DO NOTHING",
      [commandId, (await f.status()).accountKey],
    );
    assert.equal((await f.status()).permissionActive, false);
    const a = await f.prepare();
    await f.confirm(a);
    const state = await f.status();
    assert.equal(state.liveConfirmed, true);
    assert.equal(state.permissionActive, false);
    assert.equal(state.enabled, false);
    assert.equal(state.automation.state, "stopped");
    assert.equal(state.orders[0].status, "cancelled");
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM rocket_trade_policy WHERE connection_id=?",
          [f.id],
        )
      ).length,
      0,
    );
    assert.equal((await f.send()).command, "NONE");
  } finally {
    await f.db.close();
  }
});

test("an invalid Live confirmation cannot interrupt an existing run, while valid reactivation always requires a separate Start", async () => {
  const f = await setup();
  try {
    await approveFixtureLive(f.trade);
    await f.start();
    const review = await f.trade.act("alice", {
      action: "preview",
      order: {
        side: "BUY",
        symbol: "XAUUSD",
        stop: 2095.2,
        takeProfit: 2110.2,
        maxLots: 0.01,
      },
    });
    await f.trade.act("alice", { action: "confirm", previewId: review.id });
    const a = await f.prepare();
    await assert.rejects(f.confirm(a, { confirmation: "wrong" }));
    let state = await f.status();
    assert.equal(state.liveConfirmed, true);
    assert.equal(state.permissionActive, true);
    assert.equal(state.automation.state, "running");
    assert.equal(state.orders[0].status, "queued");
    await f.confirm(a);
    state = await f.status();
    assert.equal(state.liveConfirmed, true);
    assert.equal(state.permissionActive, false);
    assert.equal(state.automation.state, "stopped");
    assert.equal(state.orders[0].status, "cancelled");
  } finally {
    await f.db.close();
  }
});
