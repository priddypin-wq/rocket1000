import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { analysisService } from "../server/analysis-service.mjs";
import { MODEL } from "../server/ai-analysis.mjs";
import { adaptiveProfile } from "../server/market.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { decision, fixture, market, terminal } from "./helpers.mjs";

// Interrupted-process and clock fixtures only. No external provider or broker.
async function register(f) {
  await f.service.telemetry(
    f.token,
    { ...terminal, accountType: "demo", market: market(f.now()) },
    true,
  );
}
async function interrupted(f, { health = true } = {}) {
  const id = randomUUID();
  await f.db.query(
    "INSERT INTO rocket_analyses(id,connection_id,installation_id,status,created_at) VALUES(?,?,?,?,?)",
    [id, f.id, f.token.split(".")[1], "analyzing", f.now()],
  );
  if (health)
    await f.db.query(
      "INSERT INTO rocket_ai_health(connection_id,state,checked_at) VALUES(?,?,?)",
      [f.id, "analyzing", f.now()],
    );
  return id;
}

test("analysis status exposes the injected server clock with and without a connection", async () => {
  const f = await fixture();
  try {
    const analysis = analysisService(f.db, { now: f.now });
    for (const uid of ["alice", "bob"]) {
      const status = await analysis.status(uid);
      assert.equal(status.serverTime, f.now());
      assert.equal(status.latest, null);
    }
    f.advance(12345);
    await register(f);
    assert.equal((await analysis.status("alice")).serverTime, f.now());
    assert.equal((await analysis.status("bob")).serverTime, f.now());
  } finally {
    await f.db.close();
  }
});

test("an active analysis remains busy through the exact ninety-second boundary", async () => {
  const f = await fixture();
  try {
    await register(f);
    const id = await interrupted(f);
    const analysis = analysisService(f.db, { now: f.now });
    for (const elapsed of [0, 60000, 30000]) {
      f.advance(elapsed);
      const status = await analysis.status("alice");
      assert.equal(status.serverTime, f.now());
      assert.equal(status.ai.state, "analyzing");
      assert.equal(status.ai.errorCode, null);
      assert.equal(status.latest.id, id);
      assert.equal(status.latest.status, "analyzing");
      assert.equal(status.latest.error, null);
      assert.equal(status.history[0].status, "analyzing");
    }
  } finally {
    await f.db.close();
  }
});

for (const health of [true, false]) {
  test(`an interrupted analysis${health ? " and health record" : " without a health record"} can be retried after ninety seconds with fresh terminal data`, async () => {
    const f = await fixture();
    let calls = 0;
    try {
      await register(f);
      const oldId = await interrupted(f, { health });
      const analysis = analysisService(f.db, {
        now: f.now,
        analyzer: async (snapshot) => {
          calls++;
          return {
            ...decision,
            engineVersion: ENGINE_VERSION,
            model: MODEL,
            symbol: snapshot.symbol,
            profile: adaptiveProfile(snapshot),
            responseId: "resp_health_fixture_not_a_real_request",
            analyzedAt: f.now(),
            marketTimestamp: snapshot.timestamp,
            expiresAt: snapshot.timestamp + 60000,
            executionApproved: false,
          };
        },
      });
      f.advance(90001);
      const expired = await analysis.status("alice");
      assert.equal(expired.serverTime, f.now());
      assert.equal(expired.ai.state, "error");
      assert.equal(expired.ai.errorCode, "AI_INTERRUPTED");
      assert.equal(expired.latest.id, oldId);
      assert.equal(expired.latest.status, "error");
      assert.match(expired.latest.error, /interrupted.*Retry/);
      assert.equal(expired.history[0].status, "error");
      assert.equal(calls, 0);
      // A read projects recoverable state without rewriting persisted results.
      const [stored] = await f.db.query(
        "SELECT status,completed_at,error FROM rocket_analyses WHERE id=?",
        [oldId],
      );
      assert.deepEqual(stored, {
        status: "analyzing",
        completed_at: null,
        error: null,
      });
      const oldHealth = await f.db.query(
        "SELECT state FROM rocket_ai_health WHERE connection_id=?",
        [f.id],
      );
      assert.deepEqual(oldHealth, health ? [{ state: "analyzing" }] : []);
      await f.service.telemetry(
        f.token,
        { ...terminal, accountType: "demo", market: market(f.now()) },
        false,
      );
      const result = await analysis.start("alice");
      assert.equal(calls, 1);
      assert.equal(result.executionApproved, false);
      const current = await analysis.status("alice");
      assert.equal(current.serverTime, f.now());
      assert.equal(current.latest.id, result.id);
      assert.equal(current.latest.status, "completed");
      assert.equal(current.ai.state, "connected");
      assert.equal(current.ai.errorCode, null);
      assert.equal(current.ai.lastSuccessAt, f.now());
      assert.equal(current.history.find((a) => a.id === oldId).status, "error");
    } finally {
      await f.db.close();
    }
  });
}
