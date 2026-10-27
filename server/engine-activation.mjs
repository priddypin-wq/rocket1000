import { randomUUID, createHash } from "node:crypto";

// Internal execution fence; this value is never a public credential status.
export const environmentCredentialRevision = (env = process.env) =>
  "environment:" +
  createHash("sha256")
    .update(
      JSON.stringify([
        env.OPENAI_API_KEY || "",
        env.OPENAI_MODEL || "gpt-6.1-sol",
      ]),
    )
    .digest("hex");

export const engineActivationSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_engine_activation (connection_id TEXT PRIMARY KEY,paused INTEGER NOT NULL DEFAULT 1,generation TEXT NOT NULL,next_attempt BIGINT NOT NULL DEFAULT 0,lease_until BIGINT NOT NULL DEFAULT 0,reason TEXT,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS rocket_analysis_activation (connection_id TEXT PRIMARY KEY,paused INTEGER NOT NULL DEFAULT 0,generation TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'analysis',account_key TEXT,next_attempt BIGINT NOT NULL DEFAULT 0,lease_until BIGINT NOT NULL DEFAULT 0,reason TEXT,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS rocket_execution_intent (connection_id TEXT PRIMARY KEY,account_key TEXT NOT NULL,installation_id TEXT NOT NULL,terminal_id TEXT NOT NULL,engine_version TEXT NOT NULL,enabled_at BIGINT NOT NULL,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
];

// Analysis consent and execution consent are distinct. A newly authenticated
// installation may analyze without a trading policy; old explicit stops,
// including an operator's release pause, remain latched after migration.
export async function analysisActivationState(tx, cid) {
  const [existing] = await tx.query(
    "SELECT * FROM rocket_analysis_activation WHERE connection_id=?",
    [cid],
  );
  if (existing) return existing;
  const [execution] = await tx.query(
    "SELECT * FROM rocket_engine_activation WHERE connection_id=?",
    [cid],
  );
  const [engine] = await tx.query(
    "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
    [cid],
  );
  const [policy] = await tx.query(
    "SELECT * FROM rocket_trade_policy WHERE connection_id=?",
    [cid],
  );
  const [legacyStop] = await tx.query(
    "SELECT event FROM rocket_direct_audit WHERE connection_id=? AND event IN ('emergency_stop_all_live_permissions_revoked','approved_release_trading_paused') ORDER BY created_at DESC LIMIT 1",
    [cid],
  );
  const explicitPause = !!(
    legacyStop ||
    (execution?.paused &&
      execution.reason &&
      !/^Auto Trading is OFF\. Use Start Auto Trading/.test(
        execution.reason,
      )) ||
    (engine?.state === "stopped" &&
      /stopped by user|emergency|approved release/i.test(engine.reason || ""))
  );
  const previouslyEnabled = !!(
    policy &&
    engine &&
    !execution?.paused &&
    ["scheduled", "running"].includes(engine.state) &&
    policy.installation_id === engine.installation_id &&
    policy.session_id === engine.session_id
  );
  await tx.query(
    "INSERT INTO rocket_analysis_activation(connection_id,paused,generation,mode,account_key,reason) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id) DO NOTHING",
    [
      cid,
      explicitPause ? 1 : 0,
      randomUUID(),
      previouslyEnabled ? "execution" : "analysis",
      engine?.account_key || null,
      explicitPause ? execution?.reason || engine?.reason : null,
    ],
  );
  return (
    await tx.query(
      "SELECT * FROM rocket_analysis_activation WHERE connection_id=?",
      [cid],
    )
  )[0];
}

// Called only inside a connection-locked transaction. New installations require
// explicit Auto Trading ON. Only an already-authorized exact-account engine may
// retain its prior enablement; a connection/heartbeat never implies consent.
export async function activationState(tx, cid) {
  const [existing] = await tx.query(
    "SELECT * FROM rocket_engine_activation WHERE connection_id=?",
    [cid],
  );
  if (existing) return existing;
  const [engine] = await tx.query(
    "SELECT * FROM rocket_analysis_engine WHERE connection_id=?",
    [cid],
  );
  const [c] = await tx.query(
    "SELECT stopped FROM rocket_direct_connections WHERE id=?",
    [cid],
  );
  const [emergency] = await tx.query(
    "SELECT created_at FROM rocket_direct_audit WHERE connection_id=? AND event='emergency_stop_all_live_permissions_revoked' ORDER BY created_at DESC LIMIT 1",
    [cid],
  );
  const [policy] = await tx.query(
    "SELECT installation_id,session_id,expires_at FROM rocket_trade_policy WHERE connection_id=?",
    [cid],
  );
  const previouslyEnabled = !!(
    policy &&
    engine &&
    ["scheduled", "running"].includes(engine.state) &&
    engine.installation_id === policy.installation_id &&
    engine.session_id === policy.session_id &&
    typeof engine.account_key === "string" &&
    engine.account_key.length === 64 &&
    !c?.stopped
  );
  const paused =
    !previouslyEnabled ||
    !!(
      (engine?.state === "stopped" &&
        /stopped by user/i.test(engine.reason || "")) ||
      (c?.stopped && emergency)
    );
  await tx.query(
    "INSERT INTO rocket_engine_activation(connection_id,paused,generation,reason) VALUES(?,?,?,?) ON CONFLICT(connection_id) DO NOTHING",
    [
      cid,
      paused ? 1 : 0,
      randomUUID(),
      paused
        ? "Auto Trading is OFF. Use Start Auto Trading to enable it explicitly."
        : null,
    ],
  );
  return (
    await tx.query(
      "SELECT * FROM rocket_engine_activation WHERE connection_id=?",
      [cid],
    )
  )[0];
}

export async function pauseActivation(tx, cid, reason = "Stopped by user") {
  await tx.query(
    "INSERT INTO rocket_engine_activation(connection_id,paused,generation,reason) VALUES(?,1,?,?) ON CONFLICT(connection_id) DO UPDATE SET paused=1,generation=excluded.generation,next_attempt=0,lease_until=0,reason=excluded.reason",
    [cid, randomUUID(), reason],
  );
  await tx.query(
    "INSERT INTO rocket_analysis_activation(connection_id,paused,generation,reason) VALUES(?,1,?,?) ON CONFLICT(connection_id) DO UPDATE SET paused=1,generation=excluded.generation,next_attempt=0,lease_until=0,reason=excluded.reason",
    [cid, randomUUID(), reason],
  );
}
