import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { requestBrowserDownload } from "../lib/browser-download.mjs";
import * as actionConfirmation from "../lib/action-confirmation.mjs";

// Handler tests use controlled transports and DOM primitives only. They never
// contact an API provider, production server, MT5 terminal or broker.
const require = createRequire(import.meta.url);
const wait = () => new Promise((resolve) => setImmediate(resolve));
async function settled() {
  for (let i = 0; i < 6; i++) await wait();
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function children(node) {
  if (Array.isArray(node)) return node.flatMap(children);
  if (!node || typeof node !== "object") return [];
  return [node, ...children(node.props?.children)];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object") return text(node.props?.children);
  return typeof node === "string" || typeof node === "number"
    ? String(node)
    : "";
}
function button(tree, label) {
  const result = children(tree).find(
    (node) => node.type === "button" && text(node) === label,
  );
  assert.ok(result, `Existing button missing: ${label}`);
  return result;
}
function response(value) {
  return Response.json(value);
}

async function harness(filename, { modules = {}, initial = [] } = {}) {
  const states = [],
    refs = [],
    effects = [];
  let stateIndex = 0,
    refIndex = 0,
    effectIndex = 0;
  const hooks = {
    ...React,
    useState(value) {
      const index = stateIndex++;
      if (!(index in states))
        states[index] = index in initial ? initial[index] : value;
      return [
        states[index],
        (next) => {
          states[index] =
            typeof next === "function" ? next(states[index]) : next;
        },
      ];
    },
    useRef(value) {
      const index = refIndex++;
      return (refs[index] ||= { current: value });
    },
    useEffect(run, dependencies) {
      const index = effectIndex++;
      const previous = effects[index];
      if (
        !previous ||
        dependencies.some(
          (value, i) => !Object.is(value, previous.dependencies[i]),
        )
      )
        effects[index] = {
          run,
          dependencies,
          pending: true,
          cleanup: previous?.cleanup,
        };
    },
  };
  const source = await readFile(
    new URL(`../app/components/${filename}.tsx`, import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    fileName: `${filename}.tsx`,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const result = { exports: {} };
  const dependencies = {
    react: hooks,
    "../../lib/mt5-client": {
      mt5Api: () => {
        throw new Error("Unexpected API request in controlled handler test");
      },
    },
    "next/link": { default: "a" },
    "../../lib/browser-download.mjs": { requestBrowserDownload },
    "../../lib/action-confirmation.mjs": actionConfirmation,
    "../../lib/use-orders": {
      brokerNumber: (value) => String(value),
      useOrders: () => ({ data: null, error: "" }),
    },
    "./trading-dashboard": { ConnectedSymbols: "div" },
    "../../lib/broker-chart.mjs": {},
    "./broker-chart.module.css": {},
    ...modules,
  };
  new Function("require", "module", "exports", compiled.outputText)(
    (name) =>
      Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    result,
    result.exports,
  );
  return {
    render(props = {}, exported = "default") {
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      return result.exports[exported](props);
    },
    effects() {
      for (const effect of effects)
        if (effect.pending) {
          effect.cleanup?.();
          effect.pending = false;
          effect.cleanup = effect.run();
        }
    },
    close() {
      effects.forEach((effect) => effect.cleanup?.());
    },
  };
}

function browser() {
  const restore = [];
  const replace = (object, name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    Object.defineProperty(object, name, {
      configurable: true,
      writable: true,
      value,
    });
    restore.push(() =>
      descriptor
        ? Object.defineProperty(object, name, descriptor)
        : delete object[name],
    );
  };
  const downloads = [],
    revoked = [],
    timers = [],
    stored = new Map(),
    copied = [];
  let clipboardFailure = null;
  replace(globalThis, "location", { protocol: "https:" });
  replace(globalThis, "navigator", {
    clipboard: {
      writeText: async (value) => {
        if (clipboardFailure) throw clipboardFailure;
        copied.push(value);
      },
    },
  });
  replace(globalThis, "localStorage", {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  });
  replace(globalThis, "window", {
    setTimeout: (run, delay) => (timers.push({ run, delay }), timers.length),
    clearTimeout: () => {},
  });
  replace(globalThis, "document", {
    createElement: () => ({
      href: "",
      download: "",
      remove() {
        this.removed = true;
      },
      click() {
        downloads.push(this);
      },
    }),
    body: { appendChild: () => {} },
  });
  replace(URL, "createObjectURL", () => "blob:controlled-private-download");
  replace(URL, "revokeObjectURL", (value) => revoked.push(value));
  return {
    downloads,
    copied,
    revoked,
    stored,
    timers,
    denyClipboard: () => {
      clipboardFailure = new DOMException("Denied", "NotAllowedError");
    },
    close: () => restore.reverse().forEach((run) => run()),
  };
}

const workspace = {
  connections: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "Connected",
      installation: {
        accountLogin: "123",
        brokerServer: "Fixture-Demo",
        accountType: "demo",
        lastHeartbeat: 1800000000000,
        expiresAt: 1900000000000,
        revokedAt: null,
      },
    },
  ],
  serverUrl: "https://connection.example.test",
  downloadReady: true,
  provisioningError: "",
  verifiedAt: 1800000000000,
};
const metadata = {
  configured: true,
  verified: false,
  serverManaged: true,
  model: "fixture-model",
  connection: { connected: false },
};
const generatedConnection = {
  connectionId: workspace.connections[0].id,
  serverUrl: workspace.serverUrl,
  verifiedAt: workspace.verifiedAt,
};

test("HTTP success alone cannot claim a generated connection, revoked credential or saved key", async () => {
  const loading = await harness("mt5-connection");
  assert.match(text(loading.render()), /Checking connection/);
  assert.doesNotMatch(text(loading.render()), /MT5 CONNECTIONDisconnected/);
  loading.close();
  for (const [label, endpoint] of [
    ["Generate Connection", "generate"],
    ["Revoke EA access", "revoke"],
  ]) {
    const component = await harness("mt5-connection", {
      initial: [workspace],
      modules: {
        "../../lib/mt5-client": {
          mt5Api: async (path) => response(path === endpoint ? {} : workspace),
        },
      },
    });
    button(component.render(), label).props.onClick();
    await settled();
    const shown = text(component.render());
    assert.match(shown, /did not (?:verify|confirm)/);
    assert.doesNotMatch(
      shown,
      /HTTPS connection verified|EA credential revoked\./,
    );
    component.close();
  }
  assert.throws(
    () =>
      actionConfirmation.confirmedOpenAiAction(
        { configured: true, stored: false },
        "save",
      ),
    /did not confirm/,
  );
  assert.throws(
    () =>
      actionConfirmation.confirmedOpenAiAction(
        { configured: true, stored: false },
        "remove",
      ),
    /did not confirm/,
  );
  assert.throws(
    () =>
      actionConfirmation.verifiedConnectionResponse(
        {
          ...generatedConnection,
          connectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
        generatedConnection.connectionId,
      ),
    /did not verify/,
  );
  assert.throws(
    () =>
      actionConfirmation.verifiedConnectionResponse({
        ...generatedConnection,
        serverUrl: "https://example.test/?token=secret",
      }),
    /did not verify/,
  );
});

test("MT5 Generate and Revoke serialize synchronous taps and retain confirmed success if refresh fails", async () => {
  for (const [label, endpoint] of [
    ["Generate Connection", "generate"],
    ["Revoke EA access", "revoke"],
  ]) {
    const pending = deferred(),
      calls = [];
    const component = await harness("mt5-connection", {
      initial: [workspace],
      modules: {
        "../../lib/mt5-client": {
          mt5Api: async (path, body) => {
            calls.push({ path, body });
            if (path === endpoint) return pending.promise;
            throw new Error("Controlled refresh interruption");
          },
        },
      },
    });
    const action = button(component.render(), label).props.onClick;
    action();
    action();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, endpoint);
    pending.resolve(
      response(endpoint === "generate" ? generatedConnection : { ok: true }),
    );
    await settled();
    const result = text(component.render());
    assert.match(
      result,
      endpoint === "generate"
        ? /HTTPS connection verified/
        : /EA credential revoked/,
    );
    assert.match(
      result,
      /action succeeded, but connection status could not refresh/,
    );
    assert.equal(calls.filter((call) => call.path === endpoint).length, 1);
    component.close();
  }
});

test("MT5 Copy clears stale notices and reports clipboard denial without false success", async () => {
  const b = browser();
  try {
    const component = await harness("mt5-connection", { initial: [workspace] });
    button(component.render(), "Copy EA Connection URL").props.onClick();
    await settled();
    assert.deepEqual(b.copied, [workspace.serverUrl]);
    assert.match(text(component.render()), /MT5 URL copied/);
    b.denyClipboard();
    button(component.render(), "Copy EA Connection URL").props.onClick();
    await settled();
    const result = text(component.render());
    assert.match(result, /Clipboard permission is unavailable/);
    assert.doesNotMatch(result, /MT5 URL copied/);
    component.close();
  } finally {
    b.close();
  }
});

test("compiled EA and MetaEditor source downloads issue one request and preserve the connection", async () => {
  const b = browser();
  try {
    for (const [label, format, mime] of [
      ["Download Rocket1000 EA (.ex5)", "package", "application/zip"],
      ["Download MetaEditor source (.mq5)", "source", "text/x-mql5"],
    ]) {
      const calls = [],
        pending = deferred();
      const component = await harness("mt5-connection", {
        initial: [workspace],
        modules: {
          "../../lib/mt5-client": {
            mt5Api: async (path, body) => {
              calls.push({ path, body });
              if (path === "generate") return response(generatedConnection);
              if (path === "download") return pending.promise;
              return response(workspace);
            },
          },
        },
      });
      const action = button(component.render(), label).props.onClick;
      action();
      action();
      await settled();
      const download = calls.filter((call) => call.path === "download");
      assert.equal(download.length, 1);
      assert.deepEqual(download[0].body, {
        connectionId: workspace.connections[0].id,
        format,
      });
      pending.resolve(
        new Response("controlled artifact", {
          headers: { "Content-Type": mime },
        }),
      );
      await settled();
      assert.match(text(component.render()), /download requested/);
      assert.equal(
        b.downloads.at(-1).download,
        `ROCKET1000_EA.${format === "source" ? "mq5" : "zip"}`,
      );
      assert.equal(b.downloads.at(-1).removed, true);
      component.close();
    }
  } finally {
    b.close();
  }
});

test("EA replacement stays explicit and only the confirmed handler rotates its credential", async () => {
  const b = browser();
  try {
    const calls = [],
      pending = deferred();
    const component = await harness("mt5-connection", {
      initial: [workspace],
      modules: {
        "../../lib/mt5-client": {
          mt5Api: async (path, body) => {
            calls.push({ path, body });
            if (path === "generate") return response(generatedConnection);
            if (path === "download") return pending.promise;
            return response(workspace);
          },
        },
      },
    });
    button(component.render(), "Replace EA installation…").props.onClick();
    assert.equal(calls.length, 0);
    const action = button(component.render(), "Replace & download").props
      .onClick;
    action();
    action();
    await settled();
    assert.equal(calls.filter((call) => call.path === "download").length, 1);
    assert.equal(
      calls.find((call) => call.path === "download").body.replaceCredential,
      true,
    );
    const dialog = children(component.render()).find(
      (node) => node.type === "dialog",
    );
    let prevented = false;
    dialog.props.onCancel({
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    pending.resolve(
      new Response("controlled replacement", {
        headers: { "Content-Type": "application/zip" },
      }),
    );
    await settled();
    component.close();
  } finally {
    b.close();
  }
});

test("download validation never presents HTML or an empty response as an EA/report file", async () => {
  const b = browser();
  try {
    for (const result of [
      new Response("<html>proxy</html>", {
        headers: { "Content-Type": "text/html" },
      }),
      new Response("", { headers: { "Content-Type": "application/zip" } }),
    ])
      await assert.rejects(
        requestBrowserDownload(result, {
          filename: "ROCKET1000_EA.zip",
          contentTypes: ["application/zip"],
        }),
        /expected download|empty download/,
      );
    assert.equal(b.downloads.length, 0);
  } finally {
    b.close();
  }
});

test("OpenAI Test Connection submits one controlled verification for rapid taps", async () => {
  const b = browser();
  try {
    const calls = [],
      pending = deferred();
    const component = await harness("openai-connection", {
      modules: {
        "../../lib/mt5-client": {
          mt5Api: async (path, body) => {
            calls.push({ path, body });
            return body ? pending.promise : response(metadata);
          },
        },
      },
    });
    component.render();
    component.effects();
    await settled();
    const action = button(component.render(), "Test Connection").props.onClick;
    action();
    action();
    assert.equal(calls.filter((call) => call.body).length, 1);
    assert.deepEqual(calls.find((call) => call.body).body, { action: "test" });
    pending.resolve(
      response({
        ...metadata,
        verified: true,
        connection: { connected: true },
      }),
    );
    await settled();
    assert.match(
      text(component.render()),
      /OpenAI connection verified\. No trades were submitted/,
    );
    component.close();
  } finally {
    b.close();
  }
});

test("OpenAI Save keeps the input blank/masked and Remove requires its existing confirmation", async () => {
  const b = browser();
  try {
    const calls = [],
      pending = deferred();
    const manual = { ...metadata, serverManaged: false, encryptionReady: true };
    const component = await harness("openai-connection", {
      modules: {
        "../../lib/mt5-client": {
          mt5Api: async (path, body) => {
            calls.push({ path, body });
            return body ? pending.promise : response(manual);
          },
        },
      },
    });
    component.render();
    component.effects();
    await settled();
    let tree = component.render();
    const input = children(tree).find(
      (node) => node.type === "input" && node.props.name === "openai-api-key",
    );
    assert.equal(input.props.type, "password");
    assert.equal(input.props.value, undefined);
    input.props.ref.current = { value: "sk-controlled-test-not-a-real-key" };
    const form = children(tree).find((node) => node.type === "form");
    form.props.onSubmit({ preventDefault() {} });
    form.props.onSubmit({ preventDefault() {} });
    assert.equal(input.props.ref.current.value, "");
    assert.equal(
      calls.filter((call) => call.body?.action === "save").length,
      1,
    );
    pending.resolve(response({ ...manual, stored: true }));
    await settled();
    tree = component.render();
    button(tree, "Remove API Key").props.onClick();
    assert.equal(
      calls.filter((call) => call.body?.action === "remove").length,
      0,
    );
    const removal = deferred();
    pending.promise = removal.promise;
    const confirm = button(component.render(), "Confirm removal").props.onClick;
    confirm();
    confirm();
    assert.equal(
      calls.filter((call) => call.body?.action === "remove").length,
      1,
    );
    removal.resolve(response({ ...manual, configured: false, stored: false }));
    await settled();
    assert.match(text(component.render()), /API key removed/);
    component.close();
  } finally {
    b.close();
  }
});

test("failed OpenAI verification reports its real billing issue and releases the button", async () => {
  const b = browser();
  try {
    const failed = {
      ...metadata,
      connection: {
        connected: false,
        error: "Controlled billing activation required",
      },
    };
    const calls = [];
    const component = await harness("openai-connection", {
      modules: {
        "../../lib/mt5-client": {
          mt5Api: async (path, body) => {
            calls.push({ path, body });
            return response(body ? failed : metadata);
          },
        },
      },
    });
    component.render();
    component.effects();
    await settled();
    button(component.render(), "Test Connection").props.onClick();
    await settled();
    const result = component.render();
    assert.match(text(result), /Controlled billing activation required/);
    assert.doesNotMatch(text(result), /OpenAI connection verified/);
    assert.equal(button(result, "Test Connection").props.disabled, false);
    component.close();
  } finally {
    b.close();
  }
});

const report = {
  account: {
    login: "123",
    server: "Fixture-Demo",
    type: "demo",
    currency: "USD",
  },
  summary: "Controlled broker summary",
  generatedAt: 1800000000000,
};
test("report Copy serializes taps and refuses a switched account or unavailable clipboard", async () => {
  const b = browser();
  try {
    const calls = [],
      pending = deferred();
    const component = await harness("broker-chart", {
      modules: {
        "../../lib/mt5-client": {
          mt5Api: async (path) => (calls.push(path), pending.promise),
        },
      },
    });
    const action = button(
      component.render({ report }, "PrivateReports"),
      "Copy report",
    ).props.onClick;
    action();
    action();
    assert.equal(calls.length, 1);
    pending.resolve(
      response({ ...report, account: { ...report.account, login: "456" } }),
    );
    await settled();
    assert.equal(b.copied.length, 0);
    assert.match(
      text(component.render({ report }, "PrivateReports")),
      /account changed/,
    );
    const next = deferred();
    pending.promise = next.promise;
    b.denyClipboard();
    button(
      component.render({ report }, "PrivateReports"),
      "Copy report",
    ).props.onClick();
    next.resolve(response(report));
    await settled();
    assert.equal(b.copied.length, 0);
    assert.match(
      text(component.render({ report }, "PrivateReports")),
      /Clipboard permission was denied/,
    );
    component.close();
  } finally {
    b.close();
  }
});

test("report CSV download validates the response and reports a browser download request", async () => {
  const b = browser();
  try {
    const calls = [],
      pending = deferred();
    const component = await harness("broker-chart", {
      modules: {
        "../../lib/mt5-client": {
          mt5Api: async (path) => (calls.push(path), pending.promise),
        },
      },
    });
    const action = button(
      component.render({ report }, "PrivateReports"),
      "Download CSV",
    ).props.onClick;
    action();
    action();
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "reports?format=csv&download=1");
    pending.resolve(
      new Response("section,field,value\r\n", {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="fixture-report.csv"',
        },
      }),
    );
    await settled();
    assert.equal(b.downloads.length, 1);
    assert.equal(b.downloads[0].download, "fixture-report.csv");
    assert.match(
      text(component.render({ report }, "PrivateReports")),
      /download requested/,
    );
    component.close();
  } finally {
    b.close();
  }
});

test("notification toggles retain both rapid clicks and persist only non-secret preferences", async () => {
  const b = browser();
  try {
    const component = await harness("settings-notifications");
    component.render({ connectionStatus: null, events: [] });
    component.effects();
    for (const timer of b.timers.filter((item) => item.delay === 0))
      timer.run();
    const tree = component.render({ connectionStatus: null, events: [] });
    const toggle = children(tree).find(
      (node) =>
        node.type === "button" &&
        node.props["aria-labelledby"] === "notification-connectionAlerts",
    );
    toggle.props.onClick();
    toggle.props.onClick();
    const stored = JSON.parse(
      b.stored.get("rocket1000.settings.notifications.v1"),
    );
    assert.deepEqual(stored, {
      version: 1,
      connectionAlerts: true,
      tradeUpdates: true,
    });
    component.close();
  } finally {
    b.close();
  }
});
