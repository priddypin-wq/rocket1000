import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import * as feedback from "../lib/trading-feedback.mjs";

// Isolated client event handlers and protocol fixtures only. No HTTP, broker,
// browser credentials or OpenAI requests are used by this test harness.
const require = createRequire(import.meta.url);
const ID = "12345678-1234-4123-8123-123456789abc";
const INSTALLATION = "87654321-4321-4321-8321-cba987654321";
const SESSION = "0123456789abcdef01234567";
const NOW = 1800000000000;
const account = { login: "12345", server: "Fixture-Demo", type: "demo" };
const position = {
  ticket: "123456",
  symbol: "EURUSDm",
  volume: 0.01,
  account,
  canClose: true,
  fresh: true,
  managed: true,
  profit: 1,
};
const dashboard = {
  serverTime: NOW,
  account,
  accountKey: "account-fixture",
  permissionActive: true,
  connection: {
    id: ID,
    fresh: true,
    installationId: INSTALLATION,
    sessionId: SESSION,
  },
  positions: [position],
  blockers: [],
};
const preview = {
  id: ID,
  expiresAt: NOW + 30000,
  serverTime: NOW,
  account,
  accountKey: dashboard.accountKey,
  installationId: INSTALLATION,
  sessionId: SESSION,
  order: {
    kind: "CLOSE",
    position: position.ticket,
    symbol: position.symbol,
    volume: 0.01,
  },
};
const brokerResult = {
  retcode: 10009,
  deal: "1234567",
  filledVolume: 0.01,
  filledPrice: 1.105,
};

function nodes(element, predicate) {
  if (element === null || element === undefined || typeof element !== "object")
    return [];
  if (Array.isArray(element))
    return element.flatMap((child) => nodes(child, predicate));
  return [
    ...(predicate(element) ? [element] : []),
    ...nodes(element.props?.children, predicate),
  ];
}
function textOf(element) {
  if (Array.isArray(element)) return element.map(textOf).join("");
  if (element && typeof element === "object")
    return textOf(element.props?.children);
  return element === undefined || element === null ? "" : String(element);
}
function button(tree, text) {
  const found = nodes(
    tree,
    (node) => node.type === "button" && textOf(node).includes(text),
  )[0];
  assert.ok(found, `Expected button ${text}`);
  return found;
}
async function harness(
  filename,
  exportName,
  api,
  { initialStates = {}, effects = false } = {},
) {
  const source = await readFile(
    new URL(`../app/components/${filename}`, import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: filename,
  }).outputText;
  const hooks = [];
  const effectQueue = [];
  const timers = new Map();
  const events = [];
  let timerId = 0;
  const fakeWindow = {
    setInterval(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event) {
      events.push(event.type);
    },
  };
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks))
        hooks[index] = index in initialStates ? initialStates[index] : initial;
      return [
        hooks[index],
        (next) => {
          hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!effects) return;
      const prior = hooks[index];
      if (!prior || deps.some((dep, i) => !Object.is(dep, prior.deps[i]))) {
        effectQueue.push(() => {
          prior?.cleanup?.();
          hooks[index] = { deps, cleanup: callback() };
        });
      }
    },
    useCallback(callback) {
      cursor += 1;
      return callback;
    },
  };
  const modules = {
    react,
    "next/link": () => null,
    "./app-shell": () => null,
    "./analysis-panel": () => null,
    "./broker-chart": () => null,
    "../../lib/mt5-client": { mt5Api: api },
    "../../lib/trading-feedback.mjs": feedback,
    "../../lib/use-orders": {
      brokerNumber: String,
      brokerTime: String,
      useOrders: () => ({}),
    },
    "../../lib/use-analysis-engine": {
      useAnalysisEngine: () => ({
        data: null,
        refresh: async () => {},
        action: async () => {},
      }),
    },
  };
  const fixtureModule = { exports: {} };
  new Function("require", "module", "exports", "window", "FormData", code)(
    (name) => (Object.hasOwn(modules, name) ? modules[name] : require(name)),
    fixtureModule,
    fixtureModule.exports,
    fakeWindow,
    class FixtureFormData {
      constructor(form) {
        this.values = form.values;
      }
      get(name) {
        return this.values[name] ?? null;
      }
    },
  );
  return {
    render(props) {
      cursor = 0;
      const tree = fixtureModule.exports[exportName](props);
      for (const dialog of nodes(tree, (node) => node.type === "dialog"))
        dialog.props.ref.current = { showModal() {}, close() {} };
      return tree;
    },
    flushEffects() {
      for (const run of effectQueue.splice(0)) run();
    },
    tick(delay) {
      for (const timer of [...timers.values()])
        if (timer.delay === delay) timer.callback();
    },
    events,
  };
}
const response = (data) => ({ json: async () => data });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("close review validates the exact account, terminal session, position and server deadline", () => {
  const context = {
    account,
    accountKey: dashboard.accountKey,
    position,
    serverTime: NOW,
    started: 1,
  };
  assert.equal(
    feedback.closeReviewFromResponse(preview, context).validFor,
    30000,
  );
  for (const changed of [
    { accountKey: "different" },
    { account: { ...account, login: "99999" } },
    { account: { ...account, type: "live" } },
    { installationId: "missing" },
    { sessionId: "missing" },
    { order: { ...preview.order, position: "other-ticket" } },
    { order: { ...preview.order, symbol: "other-symbol" } },
    { order: { ...preview.order, volume: 1 } },
    { expiresAt: NOW },
  ])
    assert.throws(
      () =>
        feedback.closeReviewFromResponse({ ...preview, ...changed }, context),
      /changed|expired/,
    );
});

test("execution feedback distinguishes pending, partial, actual broker confirmation and failed outcomes", () => {
  for (const status of ["queued", "claimed", "sending", "uncertain"]) {
    const command = { id: ID, status };
    assert.equal(feedback.closeNeedsReconciliation(command), true);
    assert.doesNotMatch(
      feedback.closeCommandFeedback(command),
      /Broker confirmed/,
    );
  }
  for (const status of ["executed", "partial"]) {
    assert.equal(
      feedback.closeHasBrokerConfirmation({ id: ID, status }),
      false,
    );
    assert.equal(feedback.closeNeedsReconciliation({ id: ID, status }), true);
    assert.doesNotMatch(
      feedback.closeCommandFeedback({ id: ID, status }),
      /Broker confirmed/,
    );
    const actual = { id: ID, status, result: brokerResult };
    assert.equal(feedback.closeHasBrokerConfirmation(actual), true);
    assert.equal(feedback.closeNeedsReconciliation(actual), false);
    assert.match(feedback.closeCommandFeedback(actual), /Broker confirmed/);
  }
  for (const patch of [
    { deal: "0" },
    { filledVolume: 0 },
    { filledPrice: null },
    { retcode: 10019 },
  ])
    assert.equal(
      feedback.closeHasBrokerConfirmation({
        id: ID,
        status: "executed",
        result: { ...brokerResult, ...patch },
      }),
      false,
    );
  assert.match(
    feedback.closeCommandFeedback({
      id: ID,
      status: "failed",
      result: { retcode: 10019 },
    }),
    /10019/,
  );
  assert.throws(
    () => feedback.closeCommandFeedback({ id: ID, status: "invented" }),
    /unavailable/,
  );
});

test("rapid Close Position taps create one private preview and rapid confirmation sends one fenced request", async () => {
  const calls = [];
  let resolvePreview;
  let resolveConfirm;
  const h = await harness(
    "trading-dashboard.tsx",
    "OpenOrders",
    async (path, body) => {
      calls.push({ path, body });
      return new Promise((resolve) => {
        if (body.action === "preview")
          resolvePreview = () => resolve(response(preview));
        else
          resolveConfirm = () =>
            resolve(response({ id: ID, status: "queued" }));
      });
    },
  );
  const props = { data: dashboard, refresh: async () => {} };
  let tree = h.render(props);
  const close = button(tree, "Close Position").props.onClick;
  close();
  close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "trading");
  assert.equal(calls[0].body.expectedAccountKey, dashboard.accountKey);
  assert.equal(calls[0].body.expectedSessionId, SESSION);
  resolvePreview();
  await settle();
  tree = h.render(props);
  const confirm = button(tree, "Confirm DEMO close").props.onClick;
  const first = confirm();
  const second = confirm();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.previewId, ID);
  assert.equal(calls[1].body.expectedInstallationId, INSTALLATION);
  assert.equal(calls[1].body.expectedSessionId, SESSION);
  resolveConfirm();
  await Promise.all([first, second]);
  tree = h.render(props);
  assert.match(textOf(tree), /queued/);
  assert.doesNotMatch(textOf(tree), /Broker confirmed close/);
  assert.equal(button(tree, "Close Position").props.disabled, true);
});

test("a lost confirmation response keeps the same review for an idempotent retry", async () => {
  const calls = [];
  let failed = false;
  const h = await harness(
    "trading-dashboard.tsx",
    "OpenOrders",
    async (path, body) => {
      calls.push({ path, body });
      if (body.action === "preview") return response(preview);
      if (!failed) {
        failed = true;
        throw Error("Fixture response lost");
      }
      return response({ id: ID, status: "queued" });
    },
  );
  const props = { data: dashboard, refresh: async () => {} };
  let tree = h.render(props);
  button(tree, "Close Position").props.onClick();
  await settle();
  tree = h.render(props);
  await button(tree, "Confirm DEMO close").props.onClick();
  tree = h.render(props);
  assert.match(textOf(tree), /not confirmed/);
  await button(tree, "Check original close request").props.onClick();
  assert.equal(
    calls.filter((call) => call.body.action === "preview").length,
    1,
  );
  assert.deepEqual(
    calls
      .filter((call) => call.body.action === "confirm")
      .map((call) => call.body.previewId),
    [ID, ID],
  );
});

test("changed account permissions or EA session block confirmation even through an old button handler", async () => {
  const calls = [];
  const h = await harness(
    "trading-dashboard.tsx",
    "OpenOrders",
    async (path, body) => {
      calls.push({ path, body });
      return response(preview);
    },
  );
  const props = { data: dashboard, refresh: async () => {} };
  button(h.render(props), "Close Position").props.onClick();
  await settle();
  for (const changed of [
    { ...dashboard, permissionActive: false },
    { ...dashboard, accountKey: "other-account" },
    {
      ...dashboard,
      connection: {
        ...dashboard.connection,
        sessionId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
  ]) {
    const tree = h.render({ ...props, data: changed });
    const confirm = button(tree, "Confirm DEMO close");
    assert.equal(confirm.props.disabled, true);
    await confirm.props.onClick();
  }
  assert.equal(calls.length, 1);
});

test("legacy position review guards duplicate taps and refuses unavailable or external positions", async () => {
  let calls = 0;
  let release;
  const h = await harness("position-controls.tsx", "default", async () => {
    throw Error("No direct API in position controls");
  });
  const props = {
    positions: [position],
    available: true,
    busy: false,
    permitted: true,
    onReview: async () => {
      calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const close = button(h.render(props), "Review close").props.onClick;
  close();
  close();
  assert.equal(calls, 1);
  release();
  await settle();
  const tree = h.render({ ...props, available: false });
  assert.equal(nodes(tree, (node) => node.type === "button").length, 0);
  const external = h.render({
    ...props,
    positions: [{ ...position, managed: false }],
  });
  assert.equal(nodes(external, (node) => node.type === "button").length, 0);
});
