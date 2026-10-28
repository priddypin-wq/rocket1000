import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMt5Client } from "../lib/mt5-session-client.mjs";

const require = createRequire(import.meta.url);
const source = await readFile(
  new URL("../app/components/engine-diagnostics.tsx", import.meta.url),
  "utf8",
);

// Exercise the real component's handlers and polling with isolated hook state.
// No HTTP, provider, terminal or broker is contacted.
function fixture() {
  const state = [],
    effects = [],
    intervals = [],
    calls = [];
  let cursor = 0,
    mounted = false,
    rejectReview = true;
  const accountKey = "fixture-account";
  const trade = {
    account: { login: "123", server: "fixture", type: "live" },
    accountKey,
    permissionActive: false,
    liveConfirmed: false,
    connectionBlockers: ["A fresh authenticated MT5 heartbeat is required."],
    orders: [],
  };
  const modules = {
    react: {
      ...React,
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [
          state[index],
          (value) => {
            state[index] = value;
          },
        ];
      },
      useCallback: (fn) => fn,
      useEffect: (fn) => {
        if (!mounted) effects.push(fn);
      },
    },
    "../../lib/mt5-client": {
      async mt5Api(path, body, signal) {
        if (body) {
          calls.push(body);
          assert.ok(signal instanceof AbortSignal);
          if (body.action === "prepare-live") {
            if (rejectReview)
              throw Error("Live terminal verification is required.");
            return Response.json({
              id: "fixture-review",
              account: trade.account,
              accountKey,
              engineVersion: "fixture-engine",
              expiresAt: Date.now() + 120000,
            });
          }
          assert.equal(body.action, "confirm-live");
          return Response.json({ ok: true });
        }
        return Response.json(path === "trading" ? trade : { logs: [] });
      },
    },
    "../../lib/use-analysis-engine": {
      useAnalysisEngine: () => ({ data: null, refresh: async () => {} }),
      engineLabel: () => "Stopped",
    },
    "../../lib/use-orders": {
      useOrders: () => ({ data: { accountKey }, refresh: async () => {} }),
      brokerNumber: () => "—",
      brokerTime: () => "Never",
    },
    "./openai-connection": { __esModule: true, default: () => null },
  };
  const compiled = ts.transpileModule(source, {
    fileName: "engine-diagnostics.tsx",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", "window", compiled.outputText)(
    (name) => modules[name] ?? require(name),
    compiledModule,
    compiledModule.exports,
    { setInterval: (fn) => intervals.push(fn), clearInterval: () => {} },
  );
  function render() {
    cursor = 0;
    const tree = compiledModule.exports.default();
    mounted = true;
    return tree;
  }
  function nodes(node) {
    if (!React.isValidElement(node)) return [];
    return [
      node,
      ...React.Children.toArray(node.props.children).flatMap(nodes),
    ];
  }
  function find(predicate) {
    return nodes(render()).find(predicate);
  }
  return {
    calls,
    render,
    trade,
    html: () => renderToStaticMarkup(render()),
    button: (label) =>
      find((n) => n.type === "button" && n.props.children === label),
    checkbox: () => find((n) => n.type === "input"),
    allowReview: () => {
      rejectReview = false;
      trade.connectionBlockers = [];
    },
    async mount() {
      render();
      effects.forEach((fn) => fn());
      await new Promise(setImmediate);
    },
    async poll() {
      intervals[0]();
      await new Promise(setImmediate);
    },
  };
}

test("review rejection stays next to the button after a healthy poll and allows retry", async () => {
  const f = fixture();
  await f.mount();
  assert.match(
    f.html(),
    /Live review is blocked by the current terminal status/,
  );
  const request = f.button("Review this Live account").props.onClick();
  assert.ok(f.button("Checking Live account…").props.disabled);
  await request;
  await new Promise(setImmediate);
  assert.match(f.html(), /role="alert">Live terminal verification is required/);
  await f.poll();
  assert.match(f.html(), /role="alert">Live terminal verification is required/);
  assert.equal(f.button("Review this Live account").props.disabled, false);
  f.allowReview();
  f.button("Review this Live account").props.onClick();
  await new Promise(setImmediate);
  assert.doesNotMatch(f.html(), /Live terminal verification is required/);
  assert.match(f.html(), /Authorize this Live account/);
  assert.equal(f.button("Confirm account approval").props.disabled, true);
  assert.deepEqual(
    f.calls.map((c) => c.action),
    ["prepare-live", "prepare-live"],
  );
});

test("confirmation still requires consent and never starts auto trading", async () => {
  const f = fixture();
  await f.mount();
  f.allowReview();
  f.button("Review this Live account").props.onClick();
  await new Promise(setImmediate);
  f.checkbox().props.onChange({ target: { checked: true } });
  assert.equal(f.button("Confirm account approval").props.disabled, false);
  f.button("Confirm account approval").props.onClick();
  await new Promise(setImmediate);
  assert.match(f.html(), /Auto Trading remains OFF until explicitly enabled/);
  assert.deepEqual(
    f.calls.map((c) => c.action),
    ["prepare-live", "confirm-live"],
  );
});

test("the shared client forwards cancellation without replaying an authorization", async () => {
  const actions = [];
  const client = createMt5Client({
    lockManager: () => null,
    fetch: async (path, options) => {
      if (path.endsWith("/session")) return Response.json({ ok: true });
      actions.push(options);
      throw options.signal.reason;
    },
  });
  const controller = new AbortController();
  const failure = new DOMException("Timed out", "TimeoutError");
  // Aborting after initialization also must not replay the mutation.
  await client.privateBrowserSession();
  controller.abort(failure);
  await assert.rejects(
    client.mt5Api("trading", { action: "prepare-live" }, controller.signal),
    { name: "TimeoutError" },
  );
  assert.equal(actions.length, 0);
  const active = new AbortController();
  await assert.rejects(
    client.mt5Api("trading", { action: "prepare-live" }, active.signal),
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].signal, active.signal);
});
