import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fixture,
  terminal,
  market,
  seedAnalysisEngineFixture,
} from "./helpers.mjs";
import { pauseAll, verifyOff } from "../scripts/release-safety.mjs";

test("approved release latches analysis and execution OFF, cancels queued work and preserves credentials", async () => {
  const f = await fixture();
  try {
    await f.service.telemetry(
      f.token,
      { ...terminal, market: market(f.now()) },
      true,
    );
    await seedAnalysisEngineFixture(f);
    await f.db.query(
      "INSERT INTO rocket_trade_policy(connection_id,installation_id,session_id,expires_at) VALUES(?,?,?,?)",
      [f.id, f.token.split(".")[1], "fixture-session", f.now() + 3600000],
    );
    const commandId = randomUUID();
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        commandId,
        randomUUID(),
        f.id,
        f.token.split(".")[1],
        "fixture-session",
        "{}",
        "queued",
        f.now(),
        f.now() + 3600000,
      ],
    );
    await f.db.query(
      "UPDATE rocket_direct_connections SET stopped=0 WHERE id=?",
      [f.id],
    );
    const first = await pauseAll(f.db, f.now);
    assert.equal(first.tradingOff, true);
    assert.equal(first.existingCredentialsUnchanged, true);
    assert.equal(first.analysis_not_paused, 0);
    assert.equal(first.active_engines, 0);
    assert.equal(
      (
        await f.db.query(
          "SELECT status FROM rocket_trade_commands WHERE id=?",
          [commandId],
        )
      )[0].status,
      "cancelled",
    );
    assert.deepEqual(await pauseAll(f.db, f.now), first);
    await f.db.query(
      "UPDATE rocket_analysis_activation SET paused=0 WHERE connection_id=?",
      [f.id],
    );
    await assert.rejects(verifyOff(f.db), /analysis_not_paused/);
    await pauseAll(f.db, f.now);
    await f.db.query(
      "UPDATE rocket_trade_commands SET status='claimed' WHERE id=?",
      [commandId],
    );
    await assert.rejects(pauseAll(f.db, f.now), /outcome is pending/);
    assert.equal(
      (
        await f.db.query(
          "SELECT status FROM rocket_trade_commands WHERE id=?",
          [commandId],
        )
      )[0].status,
      "claimed",
    );
    await f.db.query(
      "UPDATE rocket_trade_commands SET status='uncertain' WHERE id=?",
      [commandId],
    );
    assert.equal((await verifyOff(f.db)).uncertain_commands, 1);
    assert.equal(
      (
        await f.db.query(
          "SELECT status FROM rocket_trade_commands WHERE id=?",
          [commandId],
        )
      )[0].status,
      "uncertain",
    );
  } finally {
    await f.db.close();
  }
});
