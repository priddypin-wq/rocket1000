import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEngineControls,
  engineIdentityMatches,
} from "../lib/engine-control-client.mjs";
import { liveReviewMatches } from "../lib/live-review.mjs";

// These responses are isolated UI-control fixtures, never provider/broker calls.
const stopped = {
  state: "stopped",
  executionAuthorized: false,
  controlRevision: "stopped-1",
};
const running = {
  state: "scheduled",
  executionAuthorized: true,
  controlRevision: "started-1",
};
const response = (value) => Response.json(value);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("rapid repeated Start taps share one request with the captured account identity", async () => {
  const pending = deferred(),
    sent = [];
  const controls = createEngineControls({
    request: async (path, body) => {
      sent.push({ path, body });
      return pending.promise;
    },
  });
  const body = {
    action: "start",
    expectedAccountKey: "exact-account",
    expectedInstallationId: "installation",
    expectedSessionId: "terminal-session",
    expectedControlRevision: "reviewed-revision",
  };
  const first = controls.action(body),
    second = controls.action(body);
  assert.equal(first, second);
  assert.equal(controls.getSnapshot().pendingAction, "start");
  await Promise.resolve();
  assert.deepEqual(sent, [{ path: "engine", body }]);
  pending.resolve(response(running));
  assert.equal(await first, true);
  assert.deepEqual(controls.getSnapshot().data, running);
  assert.equal(controls.getSnapshot().busy, false);
});

test("Stop does not wait for paid verification and a late Start response cannot restore ON", async () => {
  const paid = deferred(),
    sent = [];
  const controls = createEngineControls({
    request: async (path, body) => {
      sent.push({ path, body });
      return body.action === "start" ? paid.promise : response(stopped);
    },
  });
  const start = controls.action({ action: "start" });
  await Promise.resolve();
  assert.equal(await controls.action({ action: "stop" }), true);
  assert.deepEqual(sent[1], { path: "engine", body: { action: "stop" } });
  assert.deepEqual(controls.getSnapshot().data, stopped);
  paid.resolve(response(running));
  assert.equal(await start, false);
  assert.deepEqual(controls.getSnapshot().data, stopped);
});

test("a Stop tap cancels a Start that has not been sent yet", async () => {
  const sent = [];
  const controls = createEngineControls({
    request: async (path, body) => {
      sent.push({ path, body });
      return response(stopped);
    },
  });
  const start = controls.action({ action: "start-analysis" });
  const stop = controls.action({ action: "stop" });
  assert.equal(await start, false);
  assert.equal(await stop, true);
  assert.deepEqual(sent, [{ path: "engine", body: { action: "stop" } }]);
});

test("Emergency Stop preempts Start across controls and sends no close-position instruction", async () => {
  const paid = deferred(),
    emergency = deferred(),
    sent = [];
  let confirmations = 0;
  const controls = createEngineControls({
    request: async (path, body) => {
      sent.push({ path, body });
      if (path === "stop") return emergency.promise;
      return body ? paid.promise : response(stopped);
    },
    onStopped: () => {
      confirmations++;
    },
  });
  const start = controls.action({ action: "start" });
  await Promise.resolve();
  const first = controls.emergencyStop(),
    duplicate = controls.emergencyStop();
  assert.equal(first, duplicate);
  assert.equal(await controls.action({ action: "start" }), false);
  assert.equal(controls.getSnapshot().data, null);
  await Promise.resolve();
  assert.deepEqual(sent[1], { path: "stop", body: {} });
  emergency.resolve(response({ ok: true, tradingEnabled: false }));
  assert.equal(await first, true);
  assert.equal(confirmations, 1);
  paid.resolve(response(running));
  assert.equal(await start, false);
  await controls.refresh();
  assert.deepEqual(controls.getSnapshot().data, stopped);
});

test("an old status poll cannot overwrite a confirmed Stop", async () => {
  const poll = deferred();
  const controls = createEngineControls({
    request: async (_path, body) => (body ? response(stopped) : poll.promise),
  });
  const read = controls.refresh();
  await Promise.resolve();
  assert.equal(await controls.action({ action: "stop" }), true);
  poll.resolve(response(running));
  assert.equal(await read, false);
  assert.deepEqual(controls.getSnapshot().data, stopped);
});

for (const result of [
  { ok: true },
  { ok: true, tradingEnabled: true },
  { state: "stopped" },
]) {
  test(`Emergency Stop rejects an unconfirmed response ${JSON.stringify(result)}`, async () => {
    let confirmed = false;
    const controls = createEngineControls({
      request: async () => response(result),
      onStopped: () => {
        confirmed = true;
      },
    });
    assert.equal(await controls.emergencyStop(), false);
    assert.equal(confirmed, false);
    assert.match(controls.getSnapshot().error, /not confirmed/);
  });
}

test("failed actions show actual errors and a later retry is allowed", async () => {
  let attempts = 0;
  const controls = createEngineControls({
    request: async () => {
      if (++attempts === 1) throw Error("AI billing limit requires attention.");
      return response(stopped);
    },
  });
  assert.equal(await controls.action({ action: "start" }), false);
  assert.equal(controls.getSnapshot().busy, false);
  assert.match(controls.getSnapshot().error, /billing limit/);
  assert.equal(await controls.action({ action: "stop" }), true);
  assert.equal(controls.getSnapshot().error, "");
});

test("one state store updates Home and drawer subscribers consistently", async () => {
  const controls = createEngineControls({
    request: async () => response(stopped),
  });
  const home = [],
    drawer = [];
  const unhome = controls.subscribe(() => home.push(controls.getSnapshot()));
  const undrawer = controls.subscribe(() =>
    drawer.push(controls.getSnapshot()),
  );
  await controls.action({ action: "stop" });
  assert.deepEqual(home, drawer);
  assert.equal(home.at(-1).data.state, "stopped");
  unhome();
  undrawer();
});

test("Live approval review is bound to account, installation, session and risk revision", () => {
  const account = { login: "123", server: "Verified-Live", type: "live" };
  const review = {
    account,
    accountKey: "exact",
    expiresAt: 10000,
    installationId: "ea-1",
    sessionId: "session-1",
    settingsRevision: "risk-1",
  };
  const trade = { ...review };
  const orders = {
    account,
    accountKey: "exact",
    connection: { fresh: true, installationId: "ea-1", sessionId: "session-1" },
  };
  assert.equal(liveReviewMatches(review, trade, orders, 9999), true);
  assert.equal(liveReviewMatches(review, trade, orders, 10000), false);
  for (const patch of [
    { accountKey: "another" },
    { installationId: "ea-2" },
    { sessionId: "session-2" },
    { settingsRevision: "risk-2" },
    { account: { ...account, type: "demo" } },
  ])
    assert.equal(
      liveReviewMatches(review, { ...trade, ...patch }, orders, 9999),
      false,
    );
  assert.equal(
    liveReviewMatches(
      review,
      trade,
      { ...orders, connection: { ...orders.connection, fresh: false } },
      9999,
    ),
    false,
  );
  assert.equal(liveReviewMatches(review, trade, orders, 9999, true), false);
});

test("engine authorization is not combined with another account or EA session", () => {
  const engine = {
    accountKey: "account-1",
    installationId: "ea-1",
    sessionId: "session-1",
  };
  const orders = {
    accountKey: "account-1",
    connection: { installationId: "ea-1", sessionId: "session-1" },
  };
  assert.equal(engineIdentityMatches(engine, orders), true);
  for (const patch of [
    { accountKey: "account-2" },
    { installationId: "ea-2" },
    { sessionId: "session-2" },
  ])
    assert.equal(engineIdentityMatches({ ...engine, ...patch }, orders), false);
  assert.equal(engineIdentityMatches(null, orders), false);
});
