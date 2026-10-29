import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { fixture, market, terminal as account } from "./helpers.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import {
  bindEaConnection,
  eaConnectionBindingSchema,
} from "../server/ea-connection-binding.mjs";

// Isolated connection protocol fixtures. No provider, broker or production data.
const terminal = "0123456789abcdef01234567";
const session = "111111111111111111111111";
const chart = terminal + "abcd";
function report(patch = {}) {
  return {
    eaProtocol: 4,
    terminalSession: session,
    instanceId: chart,
    execution: { terminalId: terminal },
    accountLogin: "12345",
    brokerConnected: true,
    ...patch,
  };
}
async function setup() {
  const f = await fixture();
  for (const sql of eaConnectionBindingSchema) await f.db.query(sql);
  let installation = { id: f.token.split(".")[1], connection_id: f.id };
  return {
    ...f,
    installation: () => installation,
    replaceInstallation: () => {
      installation = { ...installation, id: randomUUID() };
    },
    bind: (input = report(), register = true) =>
      f.db.transaction((tx) =>
        bindEaConnection(tx, installation, input, f.now(), { register }),
      ),
    binding: async () =>
      (
        await f.db.query(
          "SELECT * FROM rocket_ea_connection_binding WHERE connection_id=?",
          [f.id],
        )
      )[0],
  };
}

test("one installation cannot alternate between two persistent MT5 terminals", async () => {
  const f = await setup();
  try {
    await f.bind();
    const original = await f.binding();
    await assert.rejects(
      f.bind(
        report({
          instanceId: "aaaaaaaaaaaaaaaaaaaaaaaaabcd",
          execution: { terminalId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
      ),
      (e) => e.code === "EA_CONNECTION_IN_USE",
    );
    assert.deepEqual(await f.binding(), original);
    f.advance(180000);
    await assert.rejects(
      f.bind(report({ execution: { terminalId: "bbbbbbbbbbbbbbbbbbbbbbbb" } })),
      (e) => e.code === "EA_CONNECTION_IN_USE",
    );
    await f.bind(report(), false);
    assert.equal((await f.binding()).terminal_id, terminal);
  } finally {
    await f.db.close();
  }
});

test("a competing chart cannot replace or disconnect the active EA", async () => {
  const f = await setup();
  try {
    await f.bind();
    const original = await f.binding();
    for (const register of [false, true])
      await assert.rejects(
        f.bind(report({ instanceId: terminal + "eeee" }), register),
        (e) => e.code === "EA_CONNECTION_IN_USE",
      );
    await assert.rejects(
      f.bind(report({ instanceId: terminal + "eeee", brokerConnected: false })),
      (e) => e.code === "EA_CONNECTION_IN_USE",
    );
    assert.deepEqual(await f.binding(), original);
  } finally {
    await f.db.close();
  }
});

test("a stale chart may be replaced on its original terminal without ownership ping-pong", async () => {
  const f = await setup();
  try {
    await f.bind();
    f.advance(90001);
    const next = report({ instanceId: terminal + "eeee" });
    await assert.rejects(
      f.bind(next, false),
      (e) => e.code === "EA_CONNECTION_IN_USE",
    );
    await f.bind(next, true);
    await assert.rejects(
      f.bind(report(), true),
      (e) => e.code === "EA_CONNECTION_IN_USE",
    );
    assert.equal((await f.binding()).instance_id, next.instanceId);
  } finally {
    await f.db.close();
  }
});

test("EA restart and account switch preserve the same terminal/chart connection", async () => {
  const f = await setup();
  try {
    await f.bind();
    const reconnect = report({
      terminalSession: "222222222222222222222222",
      accountLogin: "99999",
    });
    await assert.rejects(
      f.bind(reconnect, false),
      (e) => e.code === "EA_CONNECTION_REGISTRATION_REQUIRED",
    );
    await f.bind(reconnect, true);
    await f.bind(reconnect, false);
    await assert.rejects(
      f.bind(report(), false),
      (e) => e.code === "EA_CONNECTION_REGISTRATION_REQUIRED",
    );
    assert.equal((await f.binding()).session_id, reconnect.terminalSession);
    assert.equal((await f.binding()).terminal_id, terminal);
  } finally {
    await f.db.close();
  }
});

test("invalid modern identities and rolled-back telemetry never claim a connection", async () => {
  const f = await setup();
  try {
    for (const invalid of [
      { instanceId: "" },
      { instanceId: null },
      { terminalSession: "bad" },
      { execution: { terminalId: "bad" } },
    ])
      await assert.rejects(
        f.bind(report(invalid)),
        (e) => e.code === "EA_CONNECTION_IDENTITY_INVALID",
      );
    assert.equal(await f.binding(), undefined);
    await assert.rejects(
      f.db.transaction(async (tx) => {
        await bindEaConnection(tx, f.installation(), report(), f.now(), {
          register: true,
        });
        throw Error("Fixture rejects invalid remaining telemetry");
      }),
      /Fixture rejects/,
    );
    assert.equal(await f.binding(), undefined);
    await f.bind(report({ brokerConnected: false }));
    assert.equal(await f.binding(), undefined);
  } finally {
    await f.db.close();
  }
});

test("pre-upgrade execution identity protects its terminal before the first new registration", async () => {
  const f = await setup();
  try {
    await f.db.query(
      "INSERT INTO rocket_execution(connection_id,installation_id,session_id,payload,received_at) VALUES(?,?,?,?,?)",
      [
        f.id,
        f.installation().id,
        session,
        JSON.stringify({ protocol: 4, terminalId: terminal }),
        f.now(),
      ],
    );
    await f.db.query(
      "INSERT INTO rocket_ea_symbols(connection_id,installation_id,session_id,account_key,symbol,instance_id,received_at) VALUES(?,?,?,?,?,?,?)",
      [
        f.id,
        f.installation().id,
        session,
        "fixture",
        "EURUSDm",
        chart,
        f.now(),
      ],
    );
    await assert.rejects(
      f.bind(report({ execution: { terminalId: "aaaaaaaaaaaaaaaaaaaaaaaa" } })),
      (e) => e.code === "EA_CONNECTION_IN_USE",
    );
    await assert.rejects(
      f.bind({ eaProtocol: 3 }),
      (e) => e.code === "EA_CONNECTION_PROTOCOL_REQUIRED",
    );
    await f.bind();
    assert.equal((await f.binding()).terminal_id, terminal);
    assert.equal((await f.binding()).instance_id, chart);
  } finally {
    await f.db.close();
  }
});

test("legacy unbound installs remain compatible while modern bindings reject downgrade", async () => {
  const f = await setup();
  try {
    assert.equal(await f.bind({ eaProtocol: 3 }), null);
    assert.equal(await f.binding(), undefined);
    await f.bind();
    for (const eaProtocol of [undefined, 3])
      await assert.rejects(
        f.bind({ eaProtocol }),
        (e) => e.code === "EA_CONNECTION_PROTOCOL_REQUIRED",
      );
    assert.equal((await f.binding()).terminal_id, terminal);
  } finally {
    await f.db.close();
  }
});

test("older protocol-4 telemetry may omit chart identity until a chart-aware EA registers", async () => {
  const f = await setup();
  try {
    const oldShape = report();
    delete oldShape.instanceId;
    await f.bind(oldShape);
    assert.equal((await f.binding()).instance_id, null);
    await f.bind(oldShape, false);
    await assert.rejects(
      f.bind({ ...oldShape, chartSymbol: "EURUSDm" }),
      (e) => e.code === "EA_CONNECTION_IDENTITY_INVALID",
    );
    await assert.rejects(
      f.bind({
        ...oldShape,
        execution: { terminalId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
      }),
      (e) => e.code === "EA_CONNECTION_IN_USE",
    );
    await f.bind(report({ chartSymbol: "EURUSDm" }));
    assert.equal((await f.binding()).instance_id, chart);
    await assert.rejects(
      f.bind(oldShape),
      (e) => e.code === "EA_CONNECTION_IDENTITY_INVALID",
    );
    assert.equal((await f.binding()).instance_id, chart);
  } finally {
    await f.db.close();
  }
});

test("explicit installation replacement can bind a new terminal without inheriting the old chart", async () => {
  const f = await setup();
  try {
    await f.bind();
    f.replaceInstallation();
    const replacement = report({
      instanceId: "aaaaaaaaaaaaaaaaaaaaaaaaabcd",
      terminalSession: "333333333333333333333333",
      execution: { terminalId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    await f.bind(replacement);
    const binding = await f.binding();
    assert.equal(binding.installation_id, f.installation().id);
    assert.equal(binding.terminal_id, replacement.execution.terminalId);
    assert.equal(binding.instance_id, replacement.instanceId);
  } finally {
    await f.db.close();
  }
});

function completeReport(now, patch = {}) {
  return {
    ...account,
    accountType: "demo",
    accountTradeMode: 0,
    ...report(),
    chartSymbol: "XAUUSD",
    authorizedSymbols: ["XAUUSD"],
    market: market(now),
    execution: {
      engineVersion: ENGINE_VERSION,
      terminalId: terminal,
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
      tradeAllowed: false,
      stopsVerified: true,
      costsVerified: true,
      commissionPerLot: 0,
      consecutiveLosses: 0,
      consecutiveLossesVerified: true,
      newsVerified: false,
      newsBlocked: true,
      positionsAvailable: true,
      positions: [],
    },
    ...patch,
  };
}

async function ownerState(f) {
  const state = {};
  for (const [name, sql] of [
    ["account", "SELECT * FROM rocket_direct_connections WHERE id=?"],
    [
      "installation",
      "SELECT * FROM rocket_direct_installations WHERE connection_id=? AND revoked_at IS NULL",
    ],
    ["symbol", "SELECT * FROM rocket_ea_symbols WHERE connection_id=?"],
    ["market", "SELECT * FROM rocket_market_snapshots WHERE connection_id=?"],
    ["execution", "SELECT * FROM rocket_execution WHERE connection_id=?"],
    ["policy", "SELECT * FROM rocket_trade_policy WHERE connection_id=?"],
    [
      "binding",
      "SELECT * FROM rocket_ea_connection_binding WHERE connection_id=?",
    ],
  ])
    state[name] = await f.db.query(sql, [f.id]);
  return state;
}

async function seedPolicy(f, installationId) {
  // A sentinel permission row proves rejected telemetry cannot mutate current
  // authorization. TradeAllowed stays false; no executable orders are seeded.
  await f.db.query(
    "INSERT INTO rocket_trade_policy(connection_id,installation_id,session_id,expires_at) VALUES(?,?,?,?)",
    [f.id, installationId, session, f.now() + 60000],
  );
}

test("authenticated competing EA packets cannot alter any owner account, telemetry or permission state", async () => {
  const f = await fixture();
  try {
    const input = completeReport(f.now());
    await f.service.telemetry(f.token, input, true);
    await seedPolicy(f, f.token.split(".")[1]);
    const before = await ownerState(f);
    const competing = [
      {
        ...input,
        execution: {
          ...input.execution,
          terminalId: "aaaaaaaaaaaaaaaaaaaaaaaa",
        },
        instanceId: "aaaaaaaaaaaaaaaaaaaaaaaaabcd",
      },
      { ...input, instanceId: terminal + "eeee" },
      {
        ...input,
        accountLogin: "777",
        brokerServer: "Other broker",
        accountType: "live",
        accountTradeMode: 2,
        instanceId: terminal + "eeee",
      },
      {
        ...input,
        instanceId: terminal + "eeee",
        brokerConnected: false,
      },
    ];
    for (const packet of competing)
      for (const register of [true, false]) {
        await assert.rejects(
          f.service.telemetry(f.token, packet, register),
          (e) => e.code === "EA_CONNECTION_IN_USE",
        );
        assert.deepEqual(await ownerState(f), before);
      }
    const accepted = await f.service.telemetry(f.token, input, false);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.command, "NONE");
    assert.equal((await f.service.list("alice"))[0].status, "Connected");
  } finally {
    await f.db.close();
  }
});

test("replacement connection accepts its new terminal while revoked credentials cannot stop it", async () => {
  const f = await fixture();
  try {
    const input = completeReport(f.now());
    await f.service.telemetry(f.token, input, true);
    const files = unzipSync(
      await f.service.download("alice", f.id, { replaceCredential: true }),
    );
    const replacementToken = strFromU8(
      files["MQL5/Files/ROCKET1000/rocket1000.config"],
    ).match(/^credential=(.+)$/m)[1];
    assert.notEqual(replacementToken, f.token);
    const replacement = completeReport(f.now(), {
      instanceId: "aaaaaaaaaaaaaaaaaaaaaaaaabcd",
      execution: {
        ...input.execution,
        terminalId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    await f.service.telemetry(replacementToken, replacement, true);
    await seedPolicy(f, replacementToken.split(".")[1]);
    const before = await ownerState(f);
    for (const register of [true, false]) {
      await assert.rejects(
        f.service.telemetry(f.token, input, register),
        (e) => e.code === "AUTHENTICATION_FAILED",
      );
      assert.deepEqual(await ownerState(f), before);
    }
    const accepted = await f.service.telemetry(
      replacementToken,
      replacement,
      false,
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.command, "NONE");
    assert.equal((await f.service.list("alice"))[0].status, "Connected");
  } finally {
    await f.db.close();
  }
});
