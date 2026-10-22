import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { automationService } from "../server/automation.mjs";
import { tradingService } from "../server/trading.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { fixture, market, terminal } from "./helpers.mjs";

// In-memory upgrade regression only; never invokes AI or a broker.
test("a running engine stops and cancels queued orders when the EA reports an older engine", async () => {
  const f = await fixture();
  let calls = 0;
  const installationId = f.token.split(".")[1];
  const terminalSession = "0123456789abcdef01234567";
  const execution = {
    engineVersion: ENGINE_VERSION,
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
    newsVerified: true,
    newsBlocked: false,
    terminalId: "0123456789abcdef01234567",
  };
  const telemetry = (engineVersion) => ({
    ...terminal,
    accountType: "demo",
    eaProtocol: 4,
    terminalSession,
    execution: { ...execution, engineVersion },
    market: market(f.now()),
  });
  try {
    await f.service.telemetry(f.token, telemetry(ENGINE_VERSION), true);
    const trading = tradingService(f.db, { now: f.now });
    await trading.act("alice", {
      action: "start-auto",
      confirmation: "ENABLE DEMO 12345678",
      accountKey: (await trading.status("alice")).accountKey,
    });
    assert.equal((await trading.status("alice")).permissionActive, true);
    await f.service.telemetry(f.token, telemetry("rocket-ai-2"), false);
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        id,
        "fixture-queued-before-upgrade",
        f.id,
        installationId,
        terminalSession,
        JSON.stringify({ kind: "OPEN", engineVersion: "rocket-ai-2" }),
        "queued",
        f.now(),
        f.now() + 45000,
      ],
    );
    const automation = automationService(f.db, {
      now: f.now,
      analyzer: async () => {
        calls++;
        throw Error("The obsolete engine must stop before a model request.");
      },
    });
    assert.equal((await automation.cycle(installationId)).state, "stopped");
    assert.equal(calls, 0);
    const status = await trading.status("alice");
    assert.equal(status.permissionActive, false);
    assert.equal(status.enabled, false);
    assert.equal(status.automation.state, "stopped");
    assert.match(status.automation.lastError, /EA 5\.00.*current engine/);
    assert.equal(
      (
        await f.db.query(
          "SELECT status FROM rocket_trade_commands WHERE id=?",
          [id],
        )
      )[0].status,
      "cancelled",
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM rocket_analyses WHERE connection_id=?",
          [f.id],
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT connection_id FROM rocket_trade_policy WHERE connection_id=?",
          [f.id],
        )
      ).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
