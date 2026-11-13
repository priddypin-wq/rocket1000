import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { analysisQueue } from "../server/analysis-queue.mjs";
import { fixture } from "./helpers.mjs";

// Queue transport fixtures never contact OpenAI or a broker.
async function setup() {
  const f = await fixture();
  const runId = randomUUID(),
    sent = [],
    checkins = [],
    cycles = [];
  const row = async () =>
    (
      await f.db.query(
        "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
        [f.id],
      )
    )[0];
  const engine = {
    scheduler: async () => ({ configured: false }),
    heartbeat: async (...args) => checkins.push(args),
    start: async () => ({ state: "scheduled" }),
    status: async () => ({ state: (await row())?.state || "stopped" }),
    cycle: async (...args) => cycles.push(args),
  };
  const env = { VERCEL: "1", ROCKET_QUEUE_ANALYSIS: "1" };
  const publish = async (...args) => {
    sent.push(args);
    return { messageId: null };
  };
  const queue = (patch = {}) =>
    analysisQueue(f.db, { env, now: f.now, publish, engine, ...patch });
  const seed = async () => {
    await f.db.query(
      "INSERT INTO rocket_analysis_engine(connection_id,run_id,state,installation_id,session_id,account_key,key_revision) VALUES(?,?,'scheduled','','','','')",
      [f.id, runId],
    );
    await f.db.query(
      "INSERT INTO rocket_queue_dispatch(connection_id,run_id) VALUES(?,?)",
      [f.id, runId],
    );
  };
  return {
    ...f,
    runId,
    sent,
    checkins,
    cycles,
    engine,
    queue,
    seed,
    row,
    message: { connectionId: f.id, runId, cursor: 0 },
  };
}

test("queue bootstrap is debounced and only an actual callback reports health", async () => {
  const f = await setup();
  try {
    const q = f.queue();
    await q.probe("alice");
    await q.probe("alice");
    await q.probe("bob");
    assert.equal(f.sent.length, 1);
    assert.equal(f.checkins.length, 0);
    const [topic, payload] = f.sent[0];
    assert.equal(topic, "rocket1000-analysis");
    assert.deepEqual(Object.keys(payload).sort(), [
      "connectionId",
      "cursor",
      "runId",
    ]);
    await q.consume(payload);
    assert.deepEqual(f.checkins, [["queue", `queue:${f.id}:probe`]]);
    assert.equal(f.cycles.length, 0);
    f.advance(120001);
    await q.probe("alice");
    assert.equal(f.sent.length, 2);
  } finally {
    await f.db.close();
  }
});

test("queue continuation is idempotent, scoped and delayed independently of analysis frequency", async () => {
  const f = await setup();
  try {
    await f.seed();
    const q = f.queue();
    await q.consume(f.message);
    await q.consume(f.message);
    assert.deepEqual(f.cycles, [[f.id, f.runId]]);
    assert.deepEqual(f.checkins, [["queue", `queue:${f.id}:${f.runId}`]]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0][1].cursor, 1);
    assert.equal(f.sent[0][2].delaySeconds, 60);
    assert.equal(f.sent[0][2].retentionSeconds, 3600);
    await q.consume({ ...f.message, cursor: 1 });
    assert.equal(f.cycles.length, 2);
  } finally {
    await f.db.close();
  }
});

test("stopped and superseded queue generations cannot analyze or schedule work", async () => {
  const f = await setup();
  try {
    await f.seed();
    await f.db.query(
      "UPDATE rocket_analysis_engine SET run_id=?,state='stopped' WHERE connection_id=?",
      [randomUUID(), f.id],
    );
    await f.queue().consume(f.message);
    assert.equal(f.cycles.length, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.checkins.length, 0);
  } finally {
    await f.db.close();
  }
});

test("Stop during a callback prevents its continuation", async () => {
  const f = await setup();
  try {
    await f.seed();
    f.engine.cycle = async () =>
      f.db.query(
        "UPDATE rocket_analysis_engine SET state='stopped',run_id=? WHERE connection_id=?",
        [randomUUID(), f.id],
      );
    await f.queue().consume(f.message);
    assert.equal(f.sent.length, 0);
  } finally {
    await f.db.close();
  }
});

test("queue delivery failure suspends only its run and revokes new submissions", async () => {
  const f = await setup();
  try {
    await f.seed();
    f.engine.scheduler = async () => ({ configured: true });
    const q = f.queue({
      publish: async () => {
        throw Error("transport credential must not be returned");
      },
    });
    await assert.rejects(
      q.start("alice"),
      (e) =>
        e.code === "AI_SCHEDULER_UNAVAILABLE" &&
        !e.message.includes("credential"),
    );
    assert.equal((await f.row()).state, "suspended");
    assert.notEqual((await f.row()).run_id, f.runId);
    assert.equal(
      (
        await f.db.query(
          "SELECT stopped FROM rocket_direct_connections WHERE id=?",
          [f.id],
        )
      )[0].stopped,
      1,
    );
    assert.equal(f.cycles.length, 0);
  } finally {
    await f.db.close();
  }
});

test("parallel or out-of-order deliveries cannot spawn a second chain", async () => {
  const f = await setup();
  try {
    await f.seed();
    await assert.rejects(
      f.queue().consume({ ...f.message, cursor: 2 }),
      (e) => e.status === 409,
    );
    await f.db.query(
      "UPDATE rocket_queue_dispatch SET lease_until=? WHERE connection_id=?",
      [f.now() + 90000, f.id],
    );
    await assert.rejects(f.queue().consume(f.message), (e) => e.status === 409);
    assert.equal(f.cycles.length, 0);
    assert.equal(f.sent.length, 0);
    assert.equal((await f.row()).state, "scheduled");
  } finally {
    await f.db.close();
  }
});

test("queue rejects untrusted payloads and remains disabled outside configured Vercel", async () => {
  const f = await setup();
  try {
    const off = f.queue({ env: {} });
    await off.probe("alice");
    assert.equal(f.sent.length, 0);
    await assert.rejects(off.consume(f.message), (e) => e.status === 503);
    for (const input of [
      { ...f.message, command: "BUY" },
      { ...f.message, connectionId: "alice" },
      { ...f.message, cursor: -1 },
      { ...f.message, runId: "old" },
    ])
      await assert.rejects(f.queue().consume(input), (e) => e.status === 400);
    assert.equal(f.cycles.length, 0);
  } finally {
    await f.db.close();
  }
});
