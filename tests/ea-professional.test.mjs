import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateExecution } from "../server/trading.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { fixture, terminal, NOW } from "./helpers.mjs";

test("native execution independently caps risk at a quarter percent and the unchanged protocol has no tick strategy", () => {
  const source = readFileSync(
    new URL("../ea/ROCKET1000_EA.mq5", import.meta.url),
    "utf8",
  );
  assert.match(source, /#property version\s+"7\.00"/);
  assert.ok(source.includes(`!="${ENGINE_VERSION}"`));
  assert.match(source, /risk_pct<=0 \|\| risk_pct>0\.25 \|\|/);
  const onTick = source.split("void OnTick() {")[1].split("\n}")[0];
  assert.match(onTick, /FreshQuote/);
  assert.doesNotMatch(onTick, /OrderSend|ExecuteBrokerCommand/);
  assert.ok(source.includes('\\"eaProtocol\\":4'));
});

// Protocol fixtures only. These tests do not connect to MT5 or prove broker execution.
function telemetry() {
  return {
    engineVersion: ENGINE_VERSION,
    accountMarginMode: 2,
    terminalId: "0123456789abcdef01234567",
    tickSize: 0.01,
    tickValue: 1,
    point: 0.01,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 10,
    stopLevel: 10,
    dayStartEquity: 1000,
    dailyLoss: 0,
    peakEquity: 1000,
    existingRisk: 0,
    freeMargin: 1000,
    pendingOrders: 0,
    tradeAllowed: false,
    stopsVerified: true,
    costsVerified: true,
    commissionPerLot: 0,
    consecutiveLosses: 0,
    consecutiveLossesVerified: true,
    newsVerified: false,
    newsBlocked: true,
    sessionOpen: false,
    symbolTradeMode: 4,
    tradeExecutionMode: 2,
    orderMode: 49,
    fillingMode: 3,
    positionsAvailable: true,
    positions: [],
    brokerPendingAvailable: true,
    brokerPending: [],
    account: {
      balance: 1000,
      equity: 1000,
      currency: "USD",
      brokerName: "Protocol fixture broker",
      dailyProfitLoss: null,
    },
    tradeHistory: {
      available: true,
      from: NOW - 30 * 86400000,
      to: NOW + 999,
      currency: "USD",
      deals: [],
    },
  };
}

test("EA telemetry accepts unavailable daily P/L without inventing a zero", () => {
  const clean = validateExecution(telemetry());
  assert.equal(clean.account.dailyProfitLoss, null);
  assert.equal(clean.account.balance, 1000);
  assert.equal(clean.sessionOpen, false);
  assert.equal(clean.tradeAllowed, false);
  assert.equal(clean.positionsAvailable, true);
});

test("native account margin mode is verified metadata, not a browser-provided hedging switch", () => {
  for (const mode of [0, 1, 2]) {
    const sample = telemetry();
    sample.accountMarginMode = mode;
    assert.equal(validateExecution(sample).accountMarginMode, mode);
  }
  for (const mode of [-1, 3, 2.5, "2", true, null]) {
    const sample = telemetry();
    sample.accountMarginMode = mode;
    assert.throws(
      () => validateExecution(sample),
      /Invalid MT5 account margin mode/,
    );
  }
  const unknown = telemetry();
  delete unknown.accountMarginMode;
  assert.equal(validateExecution(unknown).accountMarginMode, undefined);
});

test("EA exact broker symbol registration does not depend on chart candles", async () => {
  const f = await fixture();
  try {
    const input = {
      ...terminal,
      accountType: "demo",
      accountTradeMode: 0,
      eaProtocol: 4,
      terminalSession: "0123456789abcdef01234567",
      chartSymbol: "XAUUSDm",
      authorizedSymbols: ["XAUUSDm"],
      instanceId: "0123456789abcdef012345671234abcd",
      eaVersion: "5.00",
      execution: telemetry(),
    };
    const response = await f.service.telemetry(f.token, input, true);
    assert.equal(response.ok, true);
    assert.equal(response.tradingEnabled, false);
    const [registration] = await f.db.query(
      "SELECT symbol,instance_id FROM rocket_ea_symbols WHERE connection_id=?",
      [f.id],
    );
    assert.equal(registration.symbol, "XAUUSDm");
    assert.equal(registration.instance_id, input.instanceId);
    const [candles] = await f.db.query(
      "SELECT COUNT(*) AS total FROM rocket_market_snapshots WHERE connection_id=?",
      [f.id],
    );
    assert.equal(candles.total, 0);
  } finally {
    await f.db.close();
  }
});

test("incomplete position enumeration stays distinct from a verified empty account", () => {
  const sample = telemetry();
  sample.positionsAvailable = false;
  sample.brokerPendingAvailable = false;
  const clean = validateExecution(sample);
  assert.equal(clean.positionsAvailable, false);
  assert.equal(clean.brokerPendingAvailable, false);
  assert.deepEqual(clean.positions, []);
});

test("broker deal contract preserves original command lineage and millisecond time", () => {
  const sample = telemetry();
  sample.tradeHistory.deals = [
    {
      ticket: "1234567890123456789",
      deal: "1234567890123456789",
      order: "2234567890123456789",
      positionIdentifier: "3234567890123456789",
      symbol: "XAUUSDm",
      side: "SELL",
      entry: "OUT",
      reason: "DEAL_REASON_SL",
      volume: 0.01,
      price: 2100.01,
      profit: 3.5,
      commission: -0.1,
      swap: 0,
      fee: 0,
      time: NOW + 700,
      magic: 100061,
      comment: "[sl 2100.01]",
      originComment: "R1000:aaaaaaaa-aaaa-4aaa-8aaa-aa",
      ownedIntegrity: true,
    },
  ];
  const clean = validateExecution(sample);
  assert.equal(
    clean.tradeHistory.deals[0].ticket,
    sample.tradeHistory.deals[0].ticket,
  );
  assert.equal(clean.tradeHistory.deals[0].time, NOW + 700);
  assert.equal(
    clean.tradeHistory.deals[0].originComment,
    sample.tradeHistory.deals[0].originComment,
  );
  assert.equal(clean.tradeHistory.deals[0].ownedIntegrity, true);
  sample.tradeHistory.deals[0].time = NOW + 1000;
  assert.throws(() => validateExecution(sample), /Invalid broker deal record/);
});
