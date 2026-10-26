import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fixture,
  market,
  terminal,
  seedAnalysisEngineFixture,
} from "./helpers.mjs";
import { ordersDashboardService } from "../server/orders-dashboard.mjs";
import { tradingService, validateExecution } from "../server/trading.mjs";
import { accountKey } from "../server/trade-settings.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { MODEL } from "../server/ai-analysis.mjs";
import { adaptiveProfile } from "../server/market.mjs";
import { openaiCredentialService } from "../server/openai-credentials.mjs";

// All telemetry here is isolated fixture data, never a broker or AI acceptance test.
async function setup() {
  const f = await fixture();
  const session = "0123456789abcdef01234567",
    symbol = "XAUUSDm";
  const account = { ...terminal, accountType: "demo" };
  const x = {
    engineVersion: ENGINE_VERSION,
    terminalId: session,
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
    costsVerified: true,
    commissionPerLot: 0,
    consecutiveLosses: 0,
    consecutiveLossesVerified: true,
    newsVerified: true,
    newsBlocked: false,
    positionsAvailable: true,
    positions: [],
    brokerPendingAvailable: true,
    brokerPending: [],
    account: {
      balance: 18432.81,
      equity: 18425.63,
      currency: "USD",
      brokerName: "Fixture Broker",
      dailyProfitLoss: -7.18,
    },
  };
  const input = (patch = {}) => ({
    ...account,
    eaProtocol: 4,
    terminalSession: session,
    instanceId: session,
    chartSymbol: symbol,
    authorizedSymbols: [symbol],
    eaVersion: "5.00",
    market: { ...market(f.now()), symbol },
    execution: structuredClone(x),
    ...patch,
  });
  const send = (patch = {}, register = false) =>
    f.service.telemetry(f.token, input(patch), register);
  await send({}, true);
  const dashboard = ordersDashboardService(f.db, { now: f.now });
  async function seedPosition(patch = {}) {
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        id,
        randomUUID(),
        f.id,
        f.token.split(".")[1],
        session,
        JSON.stringify({ kind: "OPEN", symbol: patch.symbol || symbol }),
        "executed",
        f.now(),
        f.now() + 45000,
      ],
    );
    await f.db.query(
      "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?)",
      [
        id,
        accountKey(
          account.accountLogin,
          account.brokerServer,
          account.accountType,
        ),
      ],
    );
    return {
      ticket: "9007199254740993123",
      identifier: "8007199254740993123",
      symbol,
      side: "BUY",
      volume: 0.02,
      open: 2099,
      currentPrice: 2100,
      stop: 2095,
      takeProfit: 2110,
      profit: 2,
      openedAt: f.now() - 60000,
      magic: 100061,
      comment: "R1000:" + id.slice(0, 24),
      ownedIntegrity: true,
      ...patch,
    };
  }
  const report = (positions) =>
    send({
      execution: { ...x, positions },
      market: { ...market(f.now()), symbol, positions },
    });
  return {
    ...f,
    x,
    input,
    send,
    report,
    seedPosition,
    status: () => dashboard.status("alice"),
    dashboard,
    account,
    symbol,
    session,
  };
}

test("exact EA broker suffix is registered; no unrelated watchlist or cross-workspace data", async () => {
  const f = await setup();
  try {
    const s = await f.status();
    assert.deepEqual(
      s.authorizedSymbols.map((v) => v.symbol),
      ["XAUUSDm"],
    );
    assert.equal(s.account.type, "demo");
    assert.equal(s.account.balance, f.x.account.balance);
    assert.equal(s.positions.length, 0);
    assert.deepEqual((await f.dashboard.status("bob")).authorizedSymbols, []);
    assert.equal(s.permissionActive, false);
  } finally {
    await f.db.close();
  }
});
test("symbol changes require fresh registration and stop authorization without guessing a new symbol", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.send({
        chartSymbol: "EURUSD",
        authorizedSymbols: ["EURUSD"],
        market: { ...market(f.now()), symbol: "EURUSD" },
      }),
      /Register it again/,
    );
    assert.deepEqual(
      (await f.status()).authorizedSymbols.map((v) => v.symbol),
      ["XAUUSDm"],
    );
    await assert.rejects(
      f.send({ authorizedSymbols: ["XAUUSDm", "EURUSD"] }, true),
      /one exact chart symbol/,
    );
    await f.send(
      {
        chartSymbol: "EURUSDm",
        authorizedSymbols: ["EURUSDm"],
        market: { ...market(f.now()), symbol: "EURUSDm" },
      },
      true,
    );
    assert.deepEqual(
      (await f.status()).authorizedSymbols.map((v) => v.symbol),
      ["EURUSDm"],
    );
  } finally {
    await f.db.close();
  }
});
test("only integrity-owned backend OPEN lineage appears; manual and other EA trades stay excluded", async () => {
  const f = await setup();
  try {
    const p = await f.seedPosition();
    await f.report([
      p,
      { ...p, ticket: "2", identifier: "2", magic: 0 },
      { ...p, ticket: "3", identifier: "3", ownedIntegrity: false },
      {
        ...p,
        ticket: "4",
        identifier: "4",
        comment: "R1000:" + "a".repeat(24),
      },
      { ...p, ticket: "5", identifier: "5", symbol: "EURUSD" },
    ]);
    const s = await f.status();
    assert.equal(s.positions.length, 1);
    assert.equal(s.positions[0].ticket, p.ticket);
    assert.equal(s.positions[0].currentPrice, 2100);
    assert.equal(s.positions[0].openedAt, p.openedAt);
    assert.equal(s.positions[0].canClose, false);
  } finally {
    await f.db.close();
  }
});
test("stale candles do not hide verified account financials or owned off-chart positions", async () => {
  const f = await setup();
  try {
    const p = await f.seedPosition({ symbol: "EURUSDm" });
    await f.send({ market: undefined, execution: { ...f.x, positions: [p] } });
    const s = await f.status();
    assert.equal(s.account.balance, f.x.account.balance);
    assert.equal(s.positions[0].symbol, "EURUSDm");
    assert.equal(s.positions[0].status, "Requires attention");
    f.advance(31000);
    const disconnected = await f.status();
    assert.deepEqual(disconnected.authorizedSymbols, []);
    assert.equal(disconnected.account.balance, null);
    assert.equal(disconnected.positions.length, 1);
    assert.equal(disconnected.positions[0].fresh, false);
  } finally {
    await f.db.close();
  }
});
test("partial volumes reconcile and broker absence alone cannot fabricate a closure", async () => {
  const f = await setup();
  try {
    const p = await f.seedPosition();
    await f.report([p]);
    await f.report([{ ...p, volume: 0.01, profit: 1 }]);
    assert.equal((await f.status()).positions[0].volume, 0.01);
    await f.report([]);
    const s = await f.status();
    assert.equal(s.positions.length, 1);
    assert.equal(s.positions[0].status, "Requires attention");
    assert.deepEqual(s.history, []);
    await f.send({
      execution: { ...f.x, positions: [], positionsAvailable: false },
    });
    assert.equal((await f.status()).positions.length, 1);
  } finally {
    await f.db.close();
  }
});
test("broker-confirmed SL/TP history closes only the reconciled owned position, without a redundant CLOSE", async () => {
  const f = await setup();
  try {
    const p = await f.seedPosition();
    await f.report([p]);
    const base = {
      positionIdentifier: p.identifier,
      symbol: p.symbol,
      magic: 100061,
      comment: "[sl]",
      originComment: p.comment,
      ownedIntegrity: true,
      side: "BUY",
      volume: p.volume,
      price: 2095,
      profit: -8,
      commission: -0.1,
      swap: 0,
      fee: 0,
      reason: "DEAL_REASON_SL",
      order: "71",
    };
    const tradeHistory = {
      available: true,
      from: f.now() - 86400000,
      to: f.now(),
      currency: "USD",
      deals: [
        { ...base, ticket: "70", entry: "IN", price: p.open, time: p.openedAt },
        { ...base, ticket: "72", entry: "OUT", time: f.now() },
      ],
    };
    await f.send({
      execution: { ...f.x, positions: [], tradeHistory },
      market: { ...market(f.now()), symbol: f.symbol, positions: [] },
    });
    const s = await f.status();
    assert.equal(s.positions.length, 0);
    assert.equal(s.history.length, 2);
    await f.send({ execution: { ...f.x, positions: [], tradeHistory } });
    assert.equal((await f.status()).history.length, 2);
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM rocket_trade_commands WHERE payload LIKE ?",
          ["%CLOSE%"],
        )
      ).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("account switch retains old owned position as attention and cannot carry over permission", async () => {
  const f = await setup();
  try {
    const p = await f.seedPosition();
    await f.report([p]);
    await f.send({ accountLogin: "999999", accountType: "live" }, true);
    const s = await f.status();
    assert.equal(s.account.login, "999999");
    assert.equal(s.liveConfirmed, false);
    assert.equal(s.positions[0].account.login, terminal.accountLogin);
    assert.equal(s.positions[0].canClose, false);
    assert.equal(s.positions[0].status, "Requires attention");
  } finally {
    await f.db.close();
  }
});
test("an owned old-symbol position may close only with its own fresh symbol checks and explicit trading permission", async () => {
  const f = await setup();
  try {
    const trade = tradingService(f.db, { now: f.now });
    const q = {
      timestamp: f.now(),
      brokerTimestamp: f.now(),
      quoteTimestamp: f.now(),
      bid: 1.105,
      ask: 1.1051,
      point: 0.00001,
      tickSize: 0.00001,
      volumeStep: 0.01,
      minVolume: 0.01,
      maxVolume: 100,
      stopLevel: 10,
      freezeLevel: 0,
      tradeAllowed: true,
    };
    const p = await f.seedPosition({
      symbol: "EURUSDm",
      open: 1.1,
      stop: 1.09,
      takeProfit: 1.12,
      currentPrice: 1.105,
      execution: q,
    });
    await f.report([p]);
    const review = () =>
      trade.act("alice", {
        action: "preview",
        order: { kind: "CLOSE", position: p.ticket },
      });
    await assert.rejects(review(), /permission/);
    await seedAnalysisEngineFixture(f);
    await trade.act("alice", {
      action: "enable",
      accountKey: (await trade.status("alice")).accountKey,
      confirmation: `ENABLE DEMO ${terminal.accountLogin}`,
    });
    const v = await review();
    assert.equal(v.order.symbol, "EURUSDm");
    assert.equal(v.order.entry, q.bid);
    assert.equal(v.order.pricePoint, q.point);
    assert.equal((await f.status()).positions[0].canClose, true);
    await assert.rejects(
      trade.act("alice", {
        action: "preview",
        order: {
          kind: "MODIFY",
          position: p.ticket,
          stop: 1.101,
          takeProfit: 1.12,
        },
      }),
      /exact symbol/,
    );
    await f.report([
      { ...p, execution: { ...q, quoteTimestamp: f.now() - 16000 } },
    ]);
    await assert.rejects(review(), /exact symbol/);
    assert.equal((await f.status()).positions[0].canClose, false);
    await f.report([{ ...p, execution: undefined }]);
    await assert.rejects(review(), /exact symbol/);
  } finally {
    await f.db.close();
  }
});
test("closing a position remains one reviewed idempotent command and rejects changed symbol prices", async () => {
  const f = await setup();
  try {
    const trade = tradingService(f.db, { now: f.now });
    const p = await f.seedPosition();
    await f.report([p]);
    await seedAnalysisEngineFixture(f);
    await trade.act("alice", {
      action: "enable",
      accountKey: (await trade.status("alice")).accountKey,
      confirmation: `ENABLE DEMO ${terminal.accountLogin}`,
    });
    const staleReview = await trade.act("alice", {
      action: "preview",
      order: { kind: "CLOSE", position: p.ticket },
    });
    await f.send({
      market: {
        ...market(f.now()),
        symbol: f.symbol,
        bid: 2101,
        ask: 2101.2,
        positions: [p],
      },
      execution: { ...f.x, positions: [p] },
    });
    await assert.rejects(
      trade.act("alice", { action: "confirm", previewId: staleReview.id }),
      /Price or risk changed/,
    );
    await f.report([p]);
    const review = await trade.act("alice", {
      action: "preview",
      order: { kind: "CLOSE", position: p.ticket },
    });
    const requests = await Promise.all([
      trade.act("alice", { action: "confirm", previewId: review.id }),
      trade.act("alice", { action: "confirm", previewId: review.id }),
    ]);
    assert.equal(requests[0].id, requests[1].id);
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM rocket_trade_commands WHERE preview_id=?",
          [review.id],
        )
      ).length,
      1,
    );
    await f.service.stop("alice");
    assert.equal((await f.status()).positions[0].canClose, false);
    assert.equal((await f.status()).positions.length, 1);
  } finally {
    await f.db.close();
  }
});
test("broker pending orders are separately authenticated; proposals never impersonate pending orders", async () => {
  const f = await setup();
  try {
    const p = await f.seedPosition();
    const o = {
      ticket: "456",
      symbol: p.symbol,
      side: "BUY",
      volume: 0.01,
      price: 2095,
      stop: 2090,
      takeProfit: 2110,
      createdAt: f.now(),
      magic: 100061,
      originComment: p.comment,
      ownedIntegrity: true,
    };
    await f.send({
      execution: {
        ...f.x,
        brokerPending: [o, { ...o, ticket: "457", magic: 0 }],
      },
    });
    const s = await f.status();
    assert.equal(s.brokerPending.length, 1);
    assert.equal(s.brokerPending[0].status, "Broker pending");
    assert.deepEqual(s.opportunities, []);
  } finally {
    await f.db.close();
  }
});
test("valid WAIT is informational only; stale, wrong-symbol and wrong-engine analyses never become opportunities", async () => {
  const f = await setup();
  try {
    const state = await tradingService(f.db, { now: f.now }).status("alice");
    const m = { ...market(f.now()), symbol: f.symbol };
    const value = {
      decision: "WAIT",
      confidence: 0.9,
      strategy: "wait",
      timeframe: "M1",
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      reasoning: "No fixture setup.",
      risks: [],
      engineVersion: ENGINE_VERSION,
      model: MODEL,
      symbol: f.symbol,
      settingsRevision: state.settingsRevision,
      marketTimestamp: f.now(),
      analyzedAt: f.now(),
      expiresAt: f.now() + 60000,
      profile: adaptiveProfile(m, state.settings),
    };
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_analyses(id,connection_id,installation_id,status,created_at,result) VALUES(?,?,?,?,?,?)",
      [
        id,
        f.id,
        f.token.split(".")[1],
        "completed",
        f.now(),
        JSON.stringify(value),
      ],
    );
    assert.equal((await f.status()).latestSignal.decision, "WAIT");
    assert.deepEqual((await f.status()).opportunities, []);
    for (const patch of [
      { engineVersion: "old" },
      { symbol: "EURUSD" },
      { expiresAt: f.now() - 1 },
    ]) {
      await f.db.query("UPDATE rocket_analyses SET result=? WHERE id=?", [
        JSON.stringify({ ...value, ...patch }),
        id,
      ]);
      assert.equal((await f.status()).latestSignal, null);
    }
  } finally {
    await f.db.close();
  }
});
test("server-configured alternative model proposals remain visible; other models cannot become opportunities", async () => {
  const f = await setup();
  const previousModel = process.env.OPENAI_MODEL;
  try {
    const model = "gpt-5-mini";
    process.env.OPENAI_MODEL = model;
    await openaiCredentialService(f.db, {
      now: f.now,
      env: {
        ROCKET_OPENAI_SERVER_MANAGED: "0",
        ROCKET_OPENAI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
    }).save("alice", {
      key: "sk-project-orders-fixture-not-a-real-key",
      model,
    });
    const state = await tradingService(f.db, { now: f.now }).status("alice");
    const m = { ...market(f.now()), symbol: f.symbol };
    const value = {
      decision: "BUY",
      confidence: 0.95,
      strategy: "trend",
      timeframe: "M1",
      entryPrice: m.ask,
      stopLoss: 2095,
      takeProfit: 2111,
      reasoning: "Isolated alternative-model proposal fixture.",
      entryAction: "OPEN",
      proposedLots: 0.01,
      positionActions: [],
      risks: [],
      engineVersion: ENGINE_VERSION,
      model,
      symbol: f.symbol,
      settingsRevision: state.settingsRevision,
      marketTimestamp: f.now(),
      analyzedAt: f.now(),
      expiresAt: f.now() + 60000,
      profile: adaptiveProfile(m, state.settings),
    };
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_analyses(id,connection_id,installation_id,status,created_at,result) VALUES(?,?,?,?,?,?)",
      [
        id,
        f.id,
        f.token.split(".")[1],
        "completed",
        f.now(),
        JSON.stringify(value),
      ],
    );
    for (const returnedModel of [model, `${model}-2026-10-01`]) {
      await f.db.query("UPDATE rocket_analyses SET result=? WHERE id=?", [
        JSON.stringify({ ...value, model: returnedModel }),
        id,
      ]);
      const s = await f.status();
      assert.equal(s.latestSignal.id, id);
      assert.equal(s.opportunities.length, 1);
      assert.equal(s.opportunities[0].id, id);
      assert.equal(s.opportunities[0].status, "Waiting for Confirmation");
      assert.deepEqual(s.positions, []);
    }
    for (const returnedModel of [MODEL, "gpt-5-mini-other", "gpt-5.4"]) {
      await f.db.query("UPDATE rocket_analyses SET result=? WHERE id=?", [
        JSON.stringify({ ...value, model: returnedModel }),
        id,
      ]);
      const s = await f.status();
      assert.equal(s.latestSignal, null);
      assert.deepEqual(s.opportunities, []);
    }
  } finally {
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
    await f.db.close();
  }
});

test("malformed broker history and account-trade-mode contradictions are rejected rather than displayed", async () => {
  const f = await setup();
  try {
    assert.throws(
      () => validateExecution({ ...f.x, positionsAvailable: "yes" }),
      /completeness/,
    );
    assert.throws(
      () =>
        validateExecution({
          ...f.x,
          tradeHistory: {
            available: true,
            from: f.now() - 86400000,
            to: f.now(),
            currency: "USD",
            deals: [{ ticket: "not-a-ticket" }],
          },
        }),
      /deal record/,
    );
    await assert.rejects(f.send({ accountTradeMode: 2 }), /terminal telemetry/);
    await assert.rejects(f.send({ accountTradeMode: 1 }), /terminal telemetry/);
    assert.equal((await f.status()).account.type, "demo");
  } finally {
    await f.db.close();
  }
});

test("proposal readiness uses deterministic risk checks and stays separate from submitted broker operations", async () => {
  const f = await setup();
  try {
    const trade = tradingService(f.db, { now: f.now });
    const state = await trade.status("alice"),
      m = { ...market(f.now()), symbol: f.symbol };
    const a = {
      decision: "BUY",
      confidence: 0.95,
      strategy: "trend",
      timeframe: "M1",
      entryPrice: m.ask,
      stopLoss: 2095,
      takeProfit: 2111,
      reasoning: "Isolated proposal fixture.",
      entryAction: "OPEN",
      proposedLots: 1,
      positionActions: [],
      risks: [],
      engineVersion: ENGINE_VERSION,
      model: MODEL,
      symbol: f.symbol,
      settingsRevision: state.settingsRevision,
      marketTimestamp: f.now(),
      analyzedAt: f.now(),
      expiresAt: f.now() + 60000,
      profile: adaptiveProfile(m, state.settings),
    };
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_analyses(id,connection_id,installation_id,status,created_at,result) VALUES(?,?,?,?,?,?)",
      [
        id,
        f.id,
        f.token.split(".")[1],
        "completed",
        f.now(),
        JSON.stringify(a),
      ],
    );
    assert.equal(
      (await f.status()).opportunities[0].status,
      "Waiting for Confirmation",
    );
    await seedAnalysisEngineFixture(f);
    await trade.act("alice", {
      action: "enable",
      accountKey: state.accountKey,
      confirmation: `ENABLE DEMO ${terminal.accountLogin}`,
    });
    assert.equal((await f.status()).opportunities[0].status, "Ready");
    const cmd = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        cmd,
        randomUUID(),
        f.id,
        f.token.split(".")[1],
        f.session,
        JSON.stringify({ kind: "OPEN", symbol: f.symbol, analysisId: id }),
        "queued",
        f.now(),
        f.now() + 45000,
      ],
    );
    await f.db.query(
      "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?)",
      [cmd, state.accountKey],
    );
    assert.equal((await f.status()).opportunities[0].status, "Ready");
    await f.db.query(
      "UPDATE rocket_trade_commands SET status='claimed' WHERE id=?",
      [cmd],
    );
    assert.equal(
      (await f.status()).opportunities[0].status,
      "Risk Check Pending",
    );
    await f.db.query(
      "UPDATE rocket_trade_commands SET status='sending' WHERE id=?",
      [cmd],
    );
    assert.equal((await f.status()).opportunities[0].status, "Submitted");
    assert.deepEqual((await f.status()).brokerPending, []);
    assert.deepEqual((await f.status()).positions, []);
  } finally {
    await f.db.close();
  }
});
