import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, market, terminal } from "./helpers.mjs";
import { autonomousStatusService } from "../server/autonomous-status.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { configuredModel } from "../server/ai-provider.mjs";
import { accountKey, tradeSettings } from "../server/trade-settings.mjs";
import { decisionBar } from "../server/market.mjs";

// Isolated, authenticated protocol fixtures only: no provider or broker calls.
async function setup(type = "demo") {
  const f = await fixture();
  const session = "0123456789abcdef01234567";
  const symbol = "XAUUSDm";
  const account = {
    ...terminal,
    accountType: type,
    accountTradeMode: type === "demo" ? 0 : 2,
  };
  const execution = {
    engineVersion: ENGINE_VERSION,
    terminalId: session,
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
    costsVerified: true,
    commissionPerLot: 0,
    consecutiveLosses: 0,
    consecutiveLossesVerified: true,
    positionsAvailable: true,
    positions: [],
    account: {
      balance: 18432.81,
      equity: 18425.63,
      currency: "USD",
      brokerName: "Fixture Broker",
      dailyProfitLoss: -7.18,
    },
  };
  const snapshot = () => ({ ...market(f.now()), symbol });
  const send = (patch = {}, register = false) =>
    f.service.telemetry(
      f.token,
      {
        ...account,
        eaProtocol: 4,
        terminalSession: session,
        chartSymbol: symbol,
        authorizedSymbols: [symbol],
        instanceId: session,
        market: snapshot(),
        execution: structuredClone(execution),
        ...patch,
      },
      register,
    );
  await send({}, true);
  const service = autonomousStatusService(f.db, { now: f.now });
  async function seedDecision(patch = {}) {
    const { revision } = await tradeSettings(f.db, f.id);
    const result = {
      decision: "WAIT",
      strategy: "wait",
      reasoning: "Fixture analysis found no confirmed entry.",
      engineVersion: ENGINE_VERSION,
      model: configuredModel(),
      symbol,
      settingsRevision: revision,
      expiresAt: f.now() + 60000,
      profile: { decisionBarTime: decisionBar(snapshot()) },
      ...patch,
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
        JSON.stringify(result),
      ],
    );
    return { id, result };
  }
  return {
    ...f,
    account,
    session,
    symbol,
    execution,
    snapshot,
    send,
    seedDecision,
    service,
    status: () => service.status("alice"),
  };
}

test("autonomous status without an account invents no market, decision or performance", async () => {
  const f = await fixture();
  try {
    const s = await autonomousStatusService(f.db, { now: f.now }).status("bob");
    assert.equal(s.state, "waiting");
    assert.equal(s.enabled, false);
    for (const key of [
      "account",
      "direction",
      "regime",
      "currentScalp",
      "dailyPnl",
      "completedScalps",
      "lastDecision",
      "metrics",
    ])
      assert.equal(s[key], null, key);
    assert.equal(s.risk.blocked, true);
  } finally {
    await f.db.close();
  }
});

for (const type of ["demo", "live"]) {
  test(`autonomous status reports authenticated ${type} identity without granting execution`, async () => {
    const f = await setup(type);
    try {
      const s = await f.status();
      assert.deepEqual(s.account, {
        login: f.account.accountLogin,
        server: f.account.brokerServer,
        type,
      });
      assert.equal(s.direction, "bullish");
      assert.equal(s.dailyPnl, -7.18);
      assert.equal(s.enabled, false);
      assert.equal(s.currentScalp, null);
      assert.equal(s.completedScalps, null);
      assert.equal(s.metrics, null);
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_trade_policy")).length,
        0,
      );
      assert.equal(
        (await f.db.query("SELECT * FROM rocket_trade_commands")).length,
        0,
      );
    } finally {
      await f.db.close();
    }
  });
}

test("fresh saved AI decision is projected read-only and WAIT never submits an order", async () => {
  const f = await setup();
  try {
    const { result } = await f.seedDecision();
    for (let i = 0; i < 2; i++) {
      const s = await f.status();
      assert.deepEqual(s.lastDecision, {
        decision: result.decision,
        reasoning: result.reasoning,
        barTime: result.profile.decisionBarTime,
      });
      assert.equal(s.activeStrategy, "wait");
      assert.equal(s.enabled, false);
    }
    assert.equal((await f.db.query("SELECT * FROM rocket_analyses")).length, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_commands")).length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_analysis_engine")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});

test("stale broker connection hides current direction, regime and saved decision", async () => {
  const f = await setup();
  try {
    await f.seedDecision({ strategy: "trend", decision: "BUY" });
    assert.equal((await f.status()).activeStrategy, "trend");
    f.advance(31000);
    const s = await f.status();
    assert.equal(s.direction, null);
    assert.equal(s.regime, null);
    assert.equal(s.lastDecision, null);
    assert.equal(s.activeStrategy, "wait");
    assert.equal(s.dailyPnl, null);
    assert.equal(s.metrics, null);
    assert.equal(s.enabled, false);
    assert.equal(s.risk.blocked, true);
    // Preserve verified identity for troubleshooting; it is not an online claim.
    assert.equal(s.account.login, f.account.accountLogin);
  } finally {
    await f.db.close();
  }
});

test("a prior candle or mismatched provider assessment is not a current AI decision", async () => {
  const f = await setup();
  try {
    const { id, result } = await f.seedDecision({
      strategy: "trend",
      decision: "BUY",
    });
    assert.equal((await f.status()).activeStrategy, "trend");
    for (const patch of [
      { profile: { decisionBarTime: result.profile.decisionBarTime - 60 } },
      { model: "unconfigured-provider-model" },
      { engineVersion: "rocket-ai-old" },
      { symbol: "EURUSD" },
      { settingsRevision: "obsolete" },
      { expiresAt: f.now() - 1 },
    ]) {
      await f.db.query("UPDATE rocket_analyses SET result=? WHERE id=?", [
        JSON.stringify({ ...result, ...patch }),
        id,
      ]);
      const s = await f.status();
      assert.equal(s.lastDecision, null);
      assert.equal(s.activeStrategy, "wait");
      assert.equal(s.direction, "bullish");
    }
  } finally {
    await f.db.close();
  }
});

test("performance includes only complete broker-reconciled Rocket1000 positions", async () => {
  const f = await setup();
  try {
    const command = randomUUID();
    const key = accountKey(
      f.account.accountLogin,
      f.account.brokerServer,
      f.account.accountType,
    );
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        command,
        randomUUID(),
        f.id,
        f.token.split(".")[1],
        f.session,
        JSON.stringify({ kind: "OPEN", symbol: f.symbol }),
        "executed",
        f.now(),
        f.now() + 45000,
      ],
    );
    await f.db.query(
      "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?)",
      [command, key],
    );
    const base = {
      positionIdentifier: "9001",
      symbol: f.symbol,
      magic: 100061,
      comment: "R1000:" + command.slice(0, 24),
      originComment: "R1000:" + command.slice(0, 24),
      ownedIntegrity: true,
      side: "BUY",
      volume: 0.01,
      price: 2100,
      profit: 0,
      commission: -0.1,
      swap: 0,
      fee: 0,
      reason: "DEAL_REASON_EXPERT",
      order: "71",
    };
    const position = {
      ticket: "9001",
      identifier: base.positionIdentifier,
      symbol: f.symbol,
      side: "BUY",
      volume: 0.01,
      open: 2100,
      currentPrice: 2100,
      stop: 2095,
      takeProfit: 2110,
      profit: 0,
      openedAt: f.now() - 60000,
      magic: base.magic,
      comment: base.comment,
      ownedIntegrity: true,
    };
    await f.send({
      market: { ...f.snapshot(), positions: [position] },
      execution: { ...f.execution, positions: [position] },
    });
    await f.send({
      execution: {
        ...f.execution,
        tradeHistory: {
          available: true,
          from: f.now() - 86400000,
          to: f.now(),
          currency: "USD",
          deals: [
            { ...base, ticket: "70", entry: "IN", time: f.now() - 60000 },
            { ...base, ticket: "72", entry: "OUT", profit: 10, time: f.now() },
            {
              ...base,
              ticket: "80",
              positionIdentifier: "9002",
              magic: 0,
              comment: "manual",
              originComment: "manual",
              entry: "OUT",
              profit: 999,
              time: f.now(),
            },
          ],
        },
      },
    });
    const s = await f.status();
    assert.equal(s.completedScalps, 1);
    assert.equal(s.metrics.trades, 1);
    assert.equal(s.metrics.winRate, 1);
    assert.ok(Math.abs(s.metrics.netExpectancy - 9.8) < 1e-8);
    assert.equal(s.metrics.profitFactor, null);
    assert.equal(s.metrics.maximumDrawdown, null);
    assert.equal(s.metrics.reversalPerformance, null);
    assert.match(s.metrics.scope, /not a backtest/);
  } finally {
    await f.db.close();
  }
});
