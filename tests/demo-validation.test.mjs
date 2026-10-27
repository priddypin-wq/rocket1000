import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  fixture,
  market,
  terminal,
  seedAnalysisEngineFixture,
  approveFixtureLive,
} from "./helpers.mjs";
import {
  demoValidation,
  recordDemoValidation,
} from "../server/demo-validation.mjs";
import { tradingService } from "../server/trading.mjs";
import { accountKey } from "../server/trade-settings.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";

// Every account, provider result and broker acknowledgement here is an isolated
// database fixture. These tests never call an AI provider or contact a broker.
const SESSION = "0123456789abcdef01234567";
const POSITION = "9007199254740993123";
const IDENTIFIER = "9007199254740993124";
const execution = {
  engineVersion: ENGINE_VERSION,
  terminalId: "abcdef0123456789abcdef01",
  tickSize: 0.01,
  tickValue: 1,
  point: 0.01,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 10,
  stopLevel: 10,
  freezeLevel: 0,
  dayStartEquity: 18432.81,
  dailyLoss: 7.18,
  peakEquity: 18432.81,
  existingRisk: 0,
  freeMargin: 18000,
  pendingOrders: 0,
  tradeAllowed: true,
  stopsVerified: true,
  costsVerified: true,
  commissionPerLot: 0,
  consecutiveLosses: 0,
  consecutiveLossesVerified: true,
  newsVerified: true,
  newsBlocked: false,
};

function multiFrame(timestamp) {
  const s = market(timestamp);
  s.timeframes = {};
  for (const [name, seconds] of Object.entries({
    M1: 60,
    M5: 300,
    M15: 900,
    H1: 3600,
  })) {
    s.timeframes[name] = {
      bars: Array.from({ length: 100 }, (_, i) => ({
        time:
          Math.floor(timestamp / (seconds * 1000)) * seconds -
          (100 - i) * seconds,
        open: 2000 + i,
        high: 2001 + i,
        low: 1999 + i,
        close: 2000.5 + i,
        volume: 100 + i,
      })),
    };
  }
  s.bars = s.timeframes.M5.bars;
  return s;
}

async function setup(type = "demo") {
  const f = await fixture();
  let identity = {
    ...terminal,
    brokerServer: "Fixture-Broker",
    accountType: type,
  };
  const input = (patch = {}) => ({
    ...identity,
    eaProtocol: 4,
    terminalSession: SESSION,
    execution,
    market: multiFrame(f.now()),
    ...patch,
  });
  const send = (patch = {}, register = false) =>
    f.service.telemetry(f.token, input(patch), register);
  await send({}, true);
  const trade = tradingService(f.db, { now: f.now });
  return {
    ...f,
    input,
    send,
    trade,
    status: () => trade.status("alice"),
    key: () =>
      accountKey(
        identity.accountLogin,
        identity.brokerServer,
        identity.accountType,
      ),
    switch: async (patch) => {
      identity = { ...identity, ...patch };
      await send({}, true);
    },
  };
}

async function seedCycle(f, mutate = () => {}) {
  const ids = {
    analysis: randomUUID(),
    open: randomUUID(),
    modify: randomUUID(),
    close: randomUUID(),
  };
  const tag = "R1000:" + ids.open.slice(0, 24);
  const assessment = {
    engineVersion: ENGINE_VERSION,
    model: "gpt-6.1-sol",
    provider: "OpenAI",
    responseId: "resp_fixture_server_response",
    decision: "BUY",
    symbol: "XAUUSD",
    confidence: 0.9,
    entryPrice: 2100.2,
    stopLoss: 2095.2,
    takeProfit: 2110.2,
    analyzedAt: f.now() - 4000,
    marketTimestamp: f.now() - 4000,
    expiresAt: f.now() + 56000,
    executionApproved: false,
  };
  const base = {
    engineVersion: ENGINE_VERSION,
    symbol: "XAUUSD",
    side: "BUY",
    volume: 0.01,
    entry: 2100.2,
    stop: 2095.2,
    takeProfit: 2110.2,
  };
  const position = {
    position: POSITION,
    positionIdentifier: IDENTIFIER,
    positionComment: tag,
  };
  const fill = {
    retcode: 10009,
    deal: "9007199254740993333",
    order: "9007199254740993334",
    filledVolume: 0.01,
    filledPrice: 2100.2,
    partial: false,
    reconciled: false,
    evidence: "broker-response",
  };
  const cycle = {
    assessment,
    open: {
      id: ids.open,
      status: "executed",
      createdAt: f.now() - 3000,
      order: { ...base, kind: "OPEN", source: "ai", analysisId: ids.analysis },
      fill: { ...fill },
    },
    modify: {
      id: ids.modify,
      status: "executed",
      createdAt: f.now() - 2000,
      order: {
        ...base,
        ...position,
        kind: "MODIFY",
        source: "ai",
        stop: 2096.2,
      },
      fill: { ...fill, deal: "0", order: "0", filledVolume: 0, filledPrice: 0 },
    },
    close: {
      id: ids.close,
      status: "sending",
      createdAt: f.now() - 1000,
      order: {
        ...base,
        ...position,
        kind: "CLOSE",
        source: "ai",
        stop: 2096.2,
      },
      fill: {
        ...fill,
        deal: "9007199254740993444",
        order: "9007199254740993445",
        filledPrice: 2102,
      },
    },
    ackStatus: "executed",
  };
  mutate(cycle);
  await f.db.query(
    "INSERT INTO rocket_analyses(id,connection_id,installation_id,status,created_at,completed_at,result) VALUES(?,?,?,?,?,?,?)",
    [
      ids.analysis,
      f.id,
      f.token.split(".")[1],
      "completed",
      f.now() - 4000,
      f.now() - 3500,
      JSON.stringify(cycle.assessment),
    ],
  );
  const lease = randomBytes(32).toString("base64url");
  for (const command of [cycle.open, cycle.modify, cycle.close]) {
    await f.db.query(
      "INSERT INTO rocket_trade_commands(id,preview_id,connection_id,installation_id,session_id,payload,status,lease_hash,created_at,expires_at,result) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [
        command.id,
        randomUUID(),
        f.id,
        f.token.split(".")[1],
        SESSION,
        JSON.stringify(command.order),
        command.status,
        command === cycle.close
          ? createHash("sha256").update(lease).digest("hex")
          : null,
        command.createdAt,
        f.now() + 45000,
        command === cycle.close ? null : JSON.stringify(command.fill),
      ],
    );
    await f.db.query(
      "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?)",
      [command.id, f.key()],
    );
  }
  return {
    cycle,
    ack: (patch = {}) =>
      f.send({
        orderResult: {
          id: ids.close,
          lease,
          status: cycle.ackStatus,
          ...cycle.close.fill,
          ...patch,
        },
      }),
  };
}

test("Demo acceptance defaults to not passed and an older engine acceptance cannot enable this engine", async () => {
  const f = await setup();
  try {
    assert.deepEqual(await demoValidation(f.db, "alice"), {
      passed: false,
      engineVersion: ENGINE_VERSION,
      completedAt: null,
    });
    await f.db.query(
      "INSERT INTO rocket_engine_validation(user_id,engine_version,completed_at,evidence) VALUES(?,?,?,?)",
      ["alice", "rocket-ai-old", f.now(), "{}"],
    );
    assert.equal((await demoValidation(f.db, "alice")).passed, false);
  } finally {
    await f.db.close();
  }
});

test("a current engine server AI response plus acknowledged Demo OPEN, same-position MODIFY and full CLOSE records exact workspace acceptance", async () => {
  const f = await setup();
  try {
    const h = await seedCycle(f);
    assert.equal(
      (await demoValidation(f.db, "alice")).passed,
      false,
      "pending CLOSE is not acceptance",
    );
    await h.ack();
    assert.deepEqual(await demoValidation(f.db, "alice"), {
      passed: true,
      engineVersion: ENGINE_VERSION,
      completedAt: f.now(),
    });
    assert.equal((await demoValidation(f.db, "bob")).passed, false);
    const [saved] = await f.db.query(
      "SELECT evidence FROM rocket_engine_validation WHERE user_id=? AND engine_version=?",
      ["alice", ENGINE_VERSION],
    );
    assert.deepEqual(JSON.parse(saved.evidence), {
      accountKey: f.key(),
      open: h.cycle.open.id,
      modify: h.cycle.modify.id,
      close: h.cycle.close.id,
      analysisId: h.cycle.open.order.analysisId,
    });
  } finally {
    await f.db.close();
  }
});

const invalidCycles = {
  "old engine OPEN": (c) => {
    c.open.order.engineVersion = "rocket-ai-old";
  },
  "old engine analysis": (c) => {
    c.assessment.engineVersion = "rocket-ai-old";
  },
  "manual OPEN": (c) => {
    c.open.order.source = "manual";
  },
  "missing AI source": (c) => {
    delete c.open.order.source;
  },
  "failed OPEN": (c) => {
    c.open.status = "failed";
  },
  "failed MODIFY": (c) => {
    c.modify.status = "failed";
  },
  "partial CLOSE": (c) => {
    c.ackStatus = "partial";
    c.close.fill.retcode = 10010;
    c.close.fill.partial = true;
    c.close.fill.filledVolume = 0.005;
  },
  "partial retcode reported as executed": (c) => {
    c.close.fill.retcode = 10010;
    c.close.fill.partial = true;
  },
  "undersized CLOSE reported as executed": (c) => {
    c.close.fill.filledVolume = 0.005;
  },
  "oversized CLOSE from an unrelated larger position": (c) => {
    c.close.fill.filledVolume = 0.02;
    c.close.order.volume = 0.02;
  },
  "different position identifier": (c) => {
    c.modify.order.positionIdentifier = "999999999999999999";
  },
  "different position ticket": (c) => {
    c.modify.order.position = "999999999999999998";
  },
  "different modification symbol": (c) => {
    c.modify.order.symbol = "EURUSD";
  },
  "different close side": (c) => {
    c.close.order.side = "SELL";
  },
  "unrelated OPEN origin comment": (c) => {
    c.close.order.positionComment = "R1000:another-position";
  },
  "missing provider response ID": (c) => {
    delete c.assessment.responseId;
  },
  "empty provider response ID": (c) => {
    c.assessment.responseId = "";
  },
  "different model": (c) => {
    c.assessment.model = "different-model";
  },
  "opposite AI decision": (c) => {
    c.assessment.decision = "SELL";
  },
  "modification created before OPEN": (c) => {
    c.modify.createdAt = c.open.createdAt - 1000;
  },
  "CLOSE created before modification": (c) => {
    c.close.createdAt = c.modify.createdAt - 500;
  },
};
for (const [name, mutate] of Object.entries(invalidCycles)) {
  test(`Demo acceptance rejects ${name}; fixture acknowledgement never contacts a broker`, async () => {
    const f = await setup();
    try {
      const h = await seedCycle(f, mutate);
      await h.ack();
      assert.equal((await demoValidation(f.db, "alice")).passed, false);
    } finally {
      await f.db.close();
    }
  });
}

test("a partial OPEN qualifies only after its actual filled volume is fully modified and closed", async () => {
  const f = await setup();
  try {
    const h = await seedCycle(f, (c) => {
      c.open.status = "partial";
      c.open.fill.retcode = 10010;
      c.open.fill.partial = true;
      c.open.fill.filledVolume = 0.005;
      c.modify.order.volume = 0.005;
      c.close.order.volume = 0.005;
      c.close.fill.filledVolume = 0.005;
    });
    await h.ack();
    assert.equal((await demoValidation(f.db, "alice")).passed, true);
  } finally {
    await f.db.close();
  }
});

test("a wrong acknowledgement lease cannot manufacture Demo acceptance", async () => {
  const f = await setup();
  try {
    const h = await seedCycle(f);
    await h.ack({ lease: randomBytes(32).toString("base64url") });
    assert.equal((await demoValidation(f.db, "alice")).passed, false);
  } finally {
    await f.db.close();
  }
});

test("another workspace cannot reuse a successful Demo cycle even through the internal record helper", async () => {
  const f = await setup();
  try {
    const h = await seedCycle(f);
    await h.ack();
    await recordDemoValidation(f.db, f.id, "bob", f.key(), f.now());
    assert.equal((await demoValidation(f.db, "bob")).passed, false);
  } finally {
    await f.db.close();
  }
});

test("Live acknowledgements never satisfy the Demo acceptance requirement", async () => {
  const f = await setup("live");
  try {
    const h = await seedCycle(f);
    await h.ack();
    assert.equal((await demoValidation(f.db, "alice")).passed, false);
    await recordDemoValidation(f.db, f.id, "alice", f.key(), f.now());
    assert.equal((await demoValidation(f.db, "alice")).passed, false);
  } finally {
    await f.db.close();
  }
});

test("Demo validation is diagnostic; Live also requires exact current-engine account authorization",async()=>{
 const f=await setup("live");try{
  const review=await f.trade.act("alice",{action:"prepare-live"});
  await f.trade.act("alice",{action:"confirm-live",id:review.id,accountKey:review.accountKey});
  assert.equal((await f.status()).permissionActive,false);
  await assert.rejects(f.trade.act("alice",{action:"start-auto",accountKey:f.key()}),/START AI/);
  await seedAnalysisEngineFixture(f);
  await f.trade.act("alice",{action:"start-auto",accountKey:f.key()});
  assert.equal((await f.status()).permissionActive,true);
  assert.equal((await demoValidation(f.db,"alice")).passed,false);
  await f.switch({accountLogin:"87654321"});
  assert.equal((await f.status()).permissionActive,false);
  await seedAnalysisEngineFixture(f);
  await assert.rejects(f.trade.act("alice",{action:"start-auto",accountKey:f.key()}),e=>e.code==="LIVE_AUTHORIZATION_REQUIRED");
  await approveFixtureLive(f.trade);
  await f.trade.act("alice",{action:"start-auto",accountKey:f.key()});
  assert.equal((await f.status()).permissionActive,true);
 }finally{await f.db.close();}
});

test("Legacy saved permission without a current authenticated AI run cannot dispatch", async () => {
  const f = await setup("live");
  try {
    await f.db.query(
      "INSERT INTO rocket_trade_policy(connection_id,installation_id,session_id,expires_at) VALUES(?,?,?,?)",
      [f.id, f.token.split(".")[1], SESSION, f.now() + 900000],
    );
    await f.db.query(
      "UPDATE rocket_direct_connections SET stopped=0 WHERE id=?",
      [f.id],
    );
    assert.equal((await f.status()).permissionActive, false);
    assert.equal((await f.send()).command, "NONE");
  } finally {
    await f.db.close();
  }
});
