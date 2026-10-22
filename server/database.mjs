import Database from "better-sqlite3";
import pg from "pg";
import { randomUUID } from "node:crypto";

// One durable store for private browser sessions, EA credentials, and audit records.
// SQLite is for a single local process. Vercel requires shared PostgreSQL.
export function openDatabase({
  url,
  filename = "work/rocket1000.sqlite",
} = {}) {
  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
    const adapter = (client) => ({
      kind: "postgres",
      query: async (sql, params = []) => {
        let i = 0;
        return (
          await client.query(
            sql.replace(/\?/g, () => `$${++i}`),
            params,
          )
        ).rows;
      },
    });
    return {
      ...adapter(pool),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await fn(adapter(client));
          await client.query("COMMIT");
          return value;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  // The setup/migration operator creates the containing local directory.
  const sqlite = new Database(filename);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  const adapter = {
    kind: "sqlite",
    async query(sql, params = []) {
      const stmt = sqlite.prepare(sql);
      return stmt.reader ? stmt.all(...params) : (stmt.run(...params), []);
    },
  };
  // Serialize all work, including reads, so another request cannot see an uncommitted transaction.
  let queue = Promise.resolve();
  function serial(fn) {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  }
  return {
    kind: "sqlite",
    query: (...args) => serial(() => adapter.query(...args)),
    transaction: (fn) =>
      serial(async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const value = await fn(adapter);
          sqlite.exec("COMMIT");
          return value;
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
      }),
    close: async () => {
      await queue;
      sqlite.close();
    },
  };
}

let store;
export function getDatabase() {
  if (!store) {
    if (
      (process.env.VERCEL || process.env.ROCKET_REQUIRE_POSTGRES === "1") &&
      !process.env.DATABASE_URL
    )
      throw new Error("DATABASE_URL is required for hosted deployments");
    store = openDatabase({
      url: process.env.DATABASE_URL,
      filename: process.env.SQLITE_PATH || "work/rocket1000.sqlite",
    });
  }
  return store;
}

export async function migrateConnections(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS rocket_workspaces (
      id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS rocket_browser_sessions (
      token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_direct_connections (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      expected_login TEXT, expected_server TEXT, expected_type TEXT CHECK(expected_type IN ('demo','live')),
      stopped INTEGER NOT NULL DEFAULT 1, created_at BIGINT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_direct_installations (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, revoked_at BIGINT,
      registered_at BIGINT, last_heartbeat BIGINT, last_error TEXT, last_error_at BIGINT,
      account_login TEXT, broker_server TEXT, account_type TEXT, terminal_build INTEGER,
      FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS rocket_direct_install_idx ON rocket_direct_installations(connection_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS rocket_direct_audit (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      event TEXT NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS rocket_direct_audit_idx ON rocket_direct_audit(user_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS rocket_rate_limits (key TEXT PRIMARY KEY, bucket BIGINT NOT NULL, hits INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS rocket_server_meta (name TEXT PRIMARY KEY,value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS rocket_market_snapshots (connection_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,payload TEXT NOT NULL,received_at BIGINT NOT NULL,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_generated_connections (connection_id TEXT PRIMARY KEY,server_url TEXT NOT NULL,verified_at BIGINT NOT NULL,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_analyses (id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,installation_id TEXT NOT NULL,status TEXT NOT NULL,created_at BIGINT NOT NULL,completed_at BIGINT,result TEXT,error TEXT,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS rocket_analysis_idx ON rocket_analyses(connection_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS rocket_execution (connection_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,session_id TEXT NOT NULL,payload TEXT NOT NULL,received_at BIGINT NOT NULL,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_ea_symbols (connection_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,session_id TEXT NOT NULL,account_key TEXT NOT NULL,symbol TEXT NOT NULL,instance_id TEXT,received_at BIGINT NOT NULL,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_owned_positions (connection_id TEXT NOT NULL,account_key TEXT NOT NULL,identifier TEXT NOT NULL,payload TEXT NOT NULL,verification_state TEXT NOT NULL,received_at BIGINT NOT NULL,PRIMARY KEY(connection_id,account_key,identifier),FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_broker_deals (connection_id TEXT NOT NULL,account_key TEXT NOT NULL,ticket TEXT NOT NULL,payload TEXT NOT NULL,broker_time BIGINT NOT NULL,received_at BIGINT NOT NULL,PRIMARY KEY(connection_id,account_key,ticket),FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_trade_policy (connection_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,session_id TEXT NOT NULL,expires_at BIGINT NOT NULL,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_order_previews (id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,installation_id TEXT NOT NULL,session_id TEXT NOT NULL,payload TEXT NOT NULL,expires_at BIGINT NOT NULL,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_trade_commands (id TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,installation_id TEXT NOT NULL,session_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,lease_hash TEXT,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,claimed_at BIGINT,result TEXT,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS rocket_trade_commands_idx ON rocket_trade_commands(connection_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS rocket_trade_preferences (connection_id TEXT PRIMARY KEY,revision TEXT NOT NULL,payload TEXT NOT NULL,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_live_consents (user_id TEXT NOT NULL,account_key TEXT NOT NULL,account_login TEXT NOT NULL,broker_server TEXT NOT NULL,confirmed_at BIGINT NOT NULL,PRIMARY KEY(user_id,account_key),FOREIGN KEY(user_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_live_approvals (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,connection_id TEXT NOT NULL,installation_id TEXT NOT NULL,session_id TEXT NOT NULL,account_key TEXT NOT NULL,settings_revision TEXT NOT NULL,engine_version TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,used_at BIGINT,payload TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE,FOREIGN KEY(installation_id) REFERENCES rocket_direct_installations(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS rocket_live_approvals_idx ON rocket_live_approvals(user_id,account_key,engine_version,used_at)`,
    `CREATE TABLE IF NOT EXISTS rocket_command_accounts (command_id TEXT PRIMARY KEY,account_key TEXT NOT NULL,FOREIGN KEY(command_id) REFERENCES rocket_trade_commands(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_automation (connection_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,installation_id TEXT NOT NULL,session_id TEXT NOT NULL,state TEXT NOT NULL,last_cycle BIGINT NOT NULL DEFAULT 0,last_bar BIGINT NOT NULL DEFAULT 0,last_action_bar BIGINT NOT NULL DEFAULT 0,lease_until BIGINT NOT NULL DEFAULT 0,last_error TEXT,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_auto_decisions (connection_id TEXT NOT NULL,run_id TEXT NOT NULL,bar_time BIGINT NOT NULL,result TEXT NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(connection_id,run_id,bar_time),FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_engine_validation (user_id TEXT NOT NULL,engine_version TEXT NOT NULL,completed_at BIGINT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(user_id,engine_version),FOREIGN KEY(user_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_ai_health (connection_id TEXT PRIMARY KEY,state TEXT NOT NULL,checked_at BIGINT NOT NULL,last_success_at BIGINT,error_code TEXT,error TEXT,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_ai_connection_checks (user_id TEXT PRIMARY KEY,config_hash TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,state TEXT NOT NULL,checked_at BIGINT NOT NULL,last_success_at BIGINT,error_code TEXT,error TEXT,request_id TEXT,lease_until BIGINT NOT NULL DEFAULT 0,FOREIGN KEY(user_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS rocket_ai_connection_budget (id TEXT PRIMARY KEY,hour_bucket BIGINT NOT NULL,hour_hits INTEGER NOT NULL,day_bucket BIGINT NOT NULL,day_hits INTEGER NOT NULL,lease_id TEXT,lease_until BIGINT NOT NULL DEFAULT 0)`,
  ];
  for (const sql of statements) await db.query(sql);
  const [
    { openaiCredentialSchema },
    { analysisEngineSchema },
    { aiUsageSchema },
  ] = await Promise.all([
    import("./openai-credentials.mjs"),
    import("./engine-service.mjs"),
    import("./ai-usage.mjs"),
  ]);
  for (const sql of [
    ...openaiCredentialSchema,
    ...analysisEngineSchema,
    ...aiUsageSchema,
  ])
    await db.query(sql);
  await db.query(
    "INSERT INTO rocket_server_meta(name,value) VALUES(?,?) ON CONFLICT(name) DO NOTHING",
    ["instance_id", randomUUID()],
  );
}
