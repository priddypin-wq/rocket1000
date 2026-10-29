import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMt5Client } from "../lib/mt5-session-client.mjs";
import { liveReviewMatches } from "../lib/live-review.mjs";
import { engineIdentityMatches } from "../lib/engine-control-client.mjs";

const require = createRequire(import.meta.url);
const source = await readFile(
  new URL("../app/components/engine-diagnostics.tsx", import.meta.url),
  "utf8",
);
const wait = () => new Promise((done) => setImmediate(done));

function fixture() {
  const states = [];
  const refs = [];
  const effects = [];
  const intervals = [];
  const calls = [];
  let stateCursor = 0;
  let refCursor = 0;
  let mounted = false;
  let reviewRejected = true;
  const account = { login: "123456", server: "Example-Live", type: "live" };
  const accountKey = "fixture-account-key";
  const installationId = "fixture-installation";
  const sessionId = "fixture-terminal-session";
  const settingsRevision = "fixture-settings";
  const trade = {
    account,
    accountKey,
    installationId,
    sessionId,
    settingsRevision,
    liveConfirmed: false,
    permissionActive: false,
    connectionBlockers: ["A fresh terminal check is required."],
    orders: [],
  };
  const orders = {
    account,
    accountKey,
    connection: { fresh: true, installationId, sessionId },
  };
  const hooks = {
    ...React,
    useState(initial) {
      const index = stateCursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => {
        states[index] = typeof value === "function" ? value(states[index]) : value;
      }];
    },
    useRef(initial) {
      const index = refCursor++;
      return (refs[index] ||= { current: initial });
    },
    useCallback: (callback) => callback,
    useEffect(callback) {
      if (!mounted) effects.push(callback);
    },
  };
  const modules = {
    react: hooks,
    "../../lib/mt5-client": {
      async mt5Api(path, body, signal) {
        if (body) {
          calls.push({ body, signal });
          assert.ok(signal instanceof AbortSignal, "Authorization must be bounded");
          if (body.action === "prepare-live") {
            if (reviewRejected) throw Error("Live terminal verification is required.");
            return Response.json({
              id: "fixture-review",
              account,
              accountKey,
              installationId,
              sessionId,
              settingsRevision,
              engineVersion: "fixture-engine",
              expiresAt: Date.now() + 120000,
            });
          }
          assert.equal(body.action, "confirm-live");
          return Response.json({
            ok: true,
            liveConfirmed: true,
            accountKey,
            executionEnabled: false,
          });
        }
        return Response.json(path === "trading" ? trade : { logs: [] });
      },
    },
    "../../lib/use-analysis-engine": {
      useAnalysisEngine: () => ({
        data: null,
        error: "",
        refresh: async () => {},
      }),
      engineLabel: () => "Stopped",
    },
    "../../lib/use-orders": {
      useOrders: () => ({
        data: orders,
        error: "",
        refresh: async () => {},
      }),
      brokerNumber: () => "—",
      brokerTime: () => "Never",
    },
    "../../lib/live-review.mjs": { liveReviewMatches },
    "../../lib/engine-control-client.mjs": { engineIdentityMatches },
    "./openai-connection": { __esModule: true, default: () => null },
  };
  const compiled = ts.transpileModule(source, {
    fileName: "engine-diagnostics.tsx",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", "window", compiled.outputText)(
    (name) => modules[name] ?? require(name),
    compiledModule,
    compiledModule.exports,
    {
      setInterval: (fn) => intervals.push(fn),
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  );
  function render() {
    stateCursor = 0;
    refCursor = 0;
    const rendered = compiledModule.exports.default();
    mounted = true;
    return rendered;
  }
  function nodes(node) {
    if (!React.isValidElement(node)) return [];
    return [
      node,
      ...React.Children.toArray(node.props.children).flatMap(nodes),
    ];
  }
  function button(label) {
    return nodes(render()).find((n) => n.type === "button" && n.props.children === label);
  }
  async function settle() {
    for (let i = 0; i < 5; i++) await wait();
  }
  return {
    calls,
    button,
    html: () => renderToStaticMarkup(render()),
    checkbox: () => nodes(render()).find((n) => n.type === "input"),
    allowReview() {
      reviewRejected = false;
      trade.connectionBlockers = [];
    },
    async mount() {
      render();
      for (const effect of effects) effect();
      await settle();
    },
    async poll() {
      intervals[0]();
      await settle();
    },
    settle,
  };
}

test("Live review failure remains visible beside controls after background polling", async () => {
  const f = fixture();
  await f.mount();
  assert.match(f.html(), /Live review is blocked by the current terminal status/);
  f.button("Review this Live account").props.onClick();
  assert.ok(f.button("Checking Live account…").props.disabled);
  await f.settle();
  assert.match(f.html(), /role="alert">Live terminal verification is required/);
  await f.poll();
  assert.match(f.html(), /role="alert">Live terminal verification is required/);
  f.allowReview();
  f.button("Review this Live account").props.onClick();
  await f.settle();
  assert.doesNotMatch(f.html(), /Live terminal verification is required/);
  assert.match(f.html(), /Authorize this Live account/);
  assert.equal(f.button("Confirm account approval").props.disabled, true);
  assert.deepEqual(f.calls.map((call) => call.body.action), [
    "prepare-live",
    "prepare-live",
  ]);
});

test("Live confirm requires explicit consent and never enables Auto Trading", async () => {
  const f = fixture();
  await f.mount();
  f.allowReview();
  f.button("Review this Live account").props.onClick();
  await f.settle();
  f.checkbox().props.onChange({ target: { checked: true } });
  assert.equal(f.button("Confirm account approval").props.disabled, false);
  f.button("Confirm account approval").props.onClick();
  await f.settle();
  assert.match(f.html(), /Auto Trading remains OFF until explicitly enabled/);
  assert.deepEqual(f.calls.map((call) => call.body.action), [
    "prepare-live",
    "confirm-live",
  ]);
});

test("MT5 client forwards cancellation and does not replay the authorization", async () => {
  const actions = [];
  const client = createMt5Client({
    lockManager: () => null,
    fetch: async (path, options) => {
      if (path.endsWith("/session")) return Response.json({ ok: true });
      actions.push(options);
      throw options.signal.reason;
    },
  });
  await client.privateBrowserSession();
  const cancelled = new AbortController();
  cancelled.abort(new DOMException("Timed out", "TimeoutError"));
  await assert.rejects(
    client.mt5Api("trading", { action: "prepare-live" }, cancelled.signal),
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
