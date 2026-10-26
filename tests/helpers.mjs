import { openDatabase, migrateConnections } from "../server/database.mjs";
import { provisioningService } from "../server/provisioning.mjs";
import { unzipSync, strFromU8 } from "fflate";
import { TIMEFRAMES } from "../server/market.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { randomUUID } from "node:crypto";
import { tradeSettings } from "../server/trade-settings.mjs";
import { adaptiveProfile } from "../server/market.mjs";
export const NOW = 1800000000000;
export const terminal = {
  accountLogin: "12345678",
  brokerServer: "Broker-Live",
  accountType: "live",
  terminalBuild: 5000,
  brokerConnected: true,
  engineVersion: ENGINE_VERSION,
};
export function market(timestamp = NOW) {
  const timeframes = Object.fromEntries(
    Object.entries(TIMEFRAMES).map(([name, seconds]) => [
      name,
      {
        bars: Array.from({ length: 220 }, (_, i) => ({
          time:
            Math.floor(timestamp / (seconds * 1000)) * seconds -
            (220 - i) * seconds,
          open: 1880 + i,
          close: 1880.5 + i,
          high: 1881 + i,
          low: 1879 + i,
          volume: 100 + i,
        })),
      },
    ]),
  );
  return {
    symbol: "XAUUSD",
    timeframe: "M5",
    timestamp,
    brokerTimestamp: timestamp,
    quoteTimestamp: timestamp,
    bid: 2100,
    ask: 2100.2,
    balance: 18432.81,
    equity: 18425.63,
    currency: "USD",
    positions: [],
    bars: structuredClone(timeframes.M5.bars),
    timeframes,
  };
}
export async function fixture() {
  const db = openDatabase({ filename: ":memory:" });
  await migrateConnections(db);
  for (const id of ["alice", "bob"])
    await db.query(
      "INSERT INTO rocket_workspaces(id,created_at,expires_at) VALUES(?,?,?)",
      [id, NOW, NOW + 180 * 86400000],
    );
  let clock = NOW;
  const now = () => clock;
  const service = provisioningService(db, {
    env: {
      ROCKET_OPENAI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    now,
    origin: () => "https://integration.example.test",
  });
  const { id } = await service.create("alice");
  async function download() {
    const files = unzipSync(await service.download("alice", id));
    return strFromU8(files["MQL5/Files/ROCKET1000/rocket1000.config"]).match(
      /^credential=(.+)$/m,
    )[1];
  }
  const token = await download();
  return {
    db,
    service,
    id,
    token,
    now,
    download,
    advance: (ms) => {
      clock += ms;
    },
  };
}
export const decision = {
  decision: "WAIT",
  confidence: 0.6,
  strategy: "wait",
  timeframe: "M1",
  entryPrice: null,
  stopLoss: null,
  takeProfit: null,
  reasoning: "No confirmed reversal in the supplied candles.",
  risks: ["Economic news is unknown."],
};

// Compatibility for execution regression fixtures: account-specific approval
// dialogs no longer grant authority. Only a seeded test engine plus START can.
export async function approveFixtureLive(trade, uid = "alice") {
  return trade.status(uid);
}

// Explicit stored model fixture for reviewed-entry protocol tests only. This
// helper is not application code, never calls a provider and cannot qualify Live.
export async function seedAiEntryFixture(f, patch = {}) {
  await seedAnalysisEngineFixture(f);
  const [snapshot] = await f.db.query(
    "SELECT payload FROM rocket_market_snapshots WHERE connection_id=?",
    [f.id],
  );
  const s = snapshot ? JSON.parse(snapshot.payload) : market(f.now());
  const { settings, revision } = await tradeSettings(f.db, f.id);
  const id = randomUUID();
  const a = {
    decision: "BUY",
    confidence: 0.95,
    strategy: "trend",
    timeframe: "M1",
    entryPrice: s.ask,
    stopLoss: 2095.2,
    takeProfit: 2110.2,
    proposedLots: 0.01,
    entryAction: "OPEN",
    positionActions: [],
    reasoning: "Isolated stored AI proposal fixture.",
    risks: [],
    model: "gpt-6.1-sol",
    engineVersion: ENGINE_VERSION,
    symbol: s.symbol,
    settingsRevision: revision,
    profile: adaptiveProfile(s, settings),
    analyzedAt: f.now(),
    marketTimestamp: s.timestamp,
    expiresAt: f.now() + 60000,
    responseId: "resp_fixture_not_a_provider_call",
    executionApproved: false,
    ...patch,
  };
  await f.db.query(
    "INSERT INTO rocket_analyses(id,connection_id,installation_id,status,created_at,result) VALUES(?,?,?,?,?,?)",
    [id, f.id, f.token.split(".")[1], "completed", f.now(), JSON.stringify(a)],
  );
  return id;
}

// Explicit test-only scheduler/job acceptance. No worker, provider or broker is
// contacted; this fixture cannot qualify the genuine Demo acceptance gate.
export async function seedAnalysisEngineFixture(f) {
  const [i] = await f.db.query(
    "SELECT * FROM rocket_direct_installations WHERE connection_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [f.id],
  );
  const [x] = await f.db.query(
    "SELECT session_id FROM rocket_execution WHERE connection_id=?",
    [f.id],
  );
  const { accountKey } = await import("../server/trade-settings.mjs");
  await f.db.query(
    "INSERT INTO rocket_engine_scheduler(id,mode,last_seen) VALUES('fixture','worker',?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen",
    [f.now()],
  );
  await f.db.query(
    "INSERT INTO rocket_analysis_engine(connection_id,run_id,state,installation_id,session_id,account_key,key_revision) VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET state=excluded.state,installation_id=excluded.installation_id,session_id=excluded.session_id,account_key=excluded.account_key",
    [
      f.id,
      randomUUID(),
      "scheduled",
      i.id,
      x?.session_id || "",
      accountKey(i.account_login, i.broker_server, i.account_type),
      "fixture-only",
    ],
  );
}
