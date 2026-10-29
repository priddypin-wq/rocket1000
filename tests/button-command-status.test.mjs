import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, terminal } from "./helpers.mjs";
import { tradingService } from "../server/trading.mjs";
import { accountKey } from "../server/trade-settings.mjs";
import { assertRequestedAccount } from "../server/requested-account.mjs";

// Database/terminal fixtures only. No order is sent to MT5 or a broker.
test("button context rejects changed identity without affecting stop controls", () => {
  const context = {
    accountKey: "a".repeat(64),
    installationId: randomUUID(),
    sessionId: "b".repeat(24),
  };
  assert.doesNotThrow(() =>
    assertRequestedAccount(context, {
      expectedAccountKey: context.accountKey,
      expectedInstallationId: context.installationId,
      expectedSessionId: context.sessionId,
    }),
  );
  for (const requested of [
    { expectedAccountKey: "c".repeat(64) },
    { expectedInstallationId: randomUUID() },
    { expectedSessionId: "d".repeat(24) },
  ])
    assert.throws(
      () => assertRequestedAccount(context, requested),
      (e) => e.code === "ACCOUNT_CONTEXT_CHANGED",
    );
  assert.throws(
    () => assertRequestedAccount(context, { expectedAccountKey: null }),
    (e) => e.code === "ACCOUNT_CONTEXT_INVALID",
  );
});

test("exact private command status reports real stored broker states and no execution secret", async () => {
  const f = await fixture();
  try {
    await f.service.telemetry(
      f.token,
      { ...terminal, accountType: "demo" },
      true,
    );
    const service = tradingService(f.db, { now: f.now });
    const key = accountKey(
      terminal.accountLogin,
      terminal.brokerServer,
      "demo",
    );
    const id = randomUUID(),
      installation = f.token.split(".")[1];
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,lease_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        randomUUID(),
        f.id,
        installation,
        "b".repeat(24),
        JSON.stringify({
          kind: "CLOSE",
          position: "123456",
          symbol: "XAUUSD",
          volume: 0.01,
        }),
        "queued",
        "private-lease-hash",
        f.now(),
        f.now() + 60000,
      ],
    );
    await f.db.query(
      "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?)",
      [id, key],
    );
    for (const status of [
      "queued",
      "claimed",
      "sending",
      "uncertain",
      "failed",
      "cancelled",
      "expired",
      "partial",
      "executed",
    ]) {
      const result = ["partial", "executed"].includes(status)
        ? {
            retcode: status === "partial" ? 10010 : 10009,
            deal: "456789",
            order: "345678",
            filledVolume: status === "partial" ? 0.005 : 0.01,
            filledPrice: 2100,
            acknowledgedAt: f.now(),
            privateToken: "must-not-return",
          }
        : status === "failed"
          ? { retcode: 10019, deal: "0", order: "0", acknowledgedAt: f.now() }
          : null;
      await f.db.query(
        "UPDATE rocket_trade_commands SET status=?,result=? WHERE id=?",
        [status, result ? JSON.stringify(result) : null, id],
      );
      const reported = await service.commandStatus("alice", id);
      assert.equal(reported.status, status);
      assert.equal(reported.id, id);
      assert.equal(reported.connectionId, f.id);
      assert.equal(reported.accountKey, key);
      assert.equal(reported.installationId, installation);
      assert.equal(reported.kind, "CLOSE");
      assert.equal(reported.position, "123456");
      assert.equal(reported.result?.retcode ?? null, result?.retcode ?? null);
      assert.ok(
        !/lease|privateToken|must-not-return|r1000\./.test(
          JSON.stringify(reported),
        ),
      );
    }
    assert.equal(
      (await f.db.query("SELECT * FROM rocket_trade_commands")).length,
      1,
    );
    await f.service.create("bob");
    await assert.rejects(
      service.commandStatus("bob", id),
      (e) => e.status === 404,
    );
    await assert.rejects(
      service.commandStatus("alice", "bad"),
      (e) => e.status === 400,
    );
    await f.db.query(
      "UPDATE rocket_direct_connections SET expected_login='999999' WHERE id=?",
      [f.id],
    );
    await assert.rejects(
      service.commandStatus("alice", id),
      (e) => e.status === 404,
    );
  } finally {
    await f.db.close();
  }
});
