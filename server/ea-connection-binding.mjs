import { ApiError } from "./errors.mjs";

export const eaConnectionBindingSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_ea_connection_binding (connection_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,terminal_id TEXT NOT NULL,instance_id TEXT,session_id TEXT NOT NULL,last_seen BIGINT NOT NULL,FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE)`,
];

const identityPattern = /^[a-f0-9]{24,64}$/;
const chartLeaseMs = 90000;
const validIdentity = (value) =>
  typeof value === "string" && identityPattern.test(value);

function competingConnection() {
  return new ApiError(
    409,
    "This EA installation already belongs to another active chart or terminal. Reconnect its original terminal or explicitly replace the EA installation.",
    "EA_CONNECTION_IN_USE",
  );
}

// Runs under the same connection lock and transaction as authenticated telemetry.
// No account, market, permission or order state may change before this guard.
export async function bindEaConnection(
  tx,
  installation,
  input,
  now,
  { register = false } = {},
) {
  const cid = installation.connection_id;
  const [stored] = await tx.query(
    "SELECT * FROM rocket_ea_connection_binding WHERE connection_id=?",
    [cid],
  );
  let binding = stored?.installation_id === installation.id ? stored : null;

  // Adopt a pre-upgrade terminal identity instead of letting the first competing
  // copy to contact a new deployment take ownership of an existing installation.
  if (!binding) {
    const [execution] = await tx.query(
      "SELECT * FROM rocket_execution WHERE connection_id=? AND installation_id=?",
      [cid, installation.id],
    );
    let payload;
    try {
      payload = execution ? JSON.parse(execution.payload) : null;
    } catch {
      // An unreadable legacy record cannot establish an identity.
    }
    if (
      payload?.protocol === 4 &&
      validIdentity(payload.terminalId) &&
      validIdentity(execution.session_id)
    ) {
      const [symbol] = await tx.query(
        "SELECT * FROM rocket_ea_symbols WHERE connection_id=? AND installation_id=?",
        [cid, installation.id],
      );
      binding = {
        connection_id: cid,
        installation_id: installation.id,
        terminal_id: payload.terminalId,
        instance_id: validIdentity(symbol?.instance_id)
          ? symbol.instance_id
          : null,
        session_id: execution.session_id,
        last_seen: Number(execution.received_at),
      };
    }
  }

  if (input.eaProtocol !== 4) {
    if (binding)
      throw new ApiError(
        409,
        "Reconnect the current authenticated EA. A legacy protocol cannot replace its connection.",
        "EA_CONNECTION_PROTOCOL_REQUIRED",
      );
    return null;
  }

  // Older protocol-4 clients omitted chart registration entirely. Preserve that
  // terminal/session-only connection until a real chart identity is reported;
  // a chart-aware installation can never downgrade to the older packet shape.
  const instance = input.instanceId ?? null;
  const chartIdentityRequired =
    input.chartSymbol !== undefined || !!binding?.instance_id;
  if (
    !validIdentity(input.execution?.terminalId) ||
    !validIdentity(input.terminalSession) ||
    (chartIdentityRequired
      ? !validIdentity(input.instanceId)
      : input.instanceId !== undefined && !validIdentity(input.instanceId))
  )
    throw new ApiError(
      422,
      "The EA must report a valid terminal, chart and session identity.",
      "EA_CONNECTION_IDENTITY_INVALID",
    );

  if (binding) {
    // A new session is a restart, not permission to move the package to a
    // different persistent terminal. Explicit credential replacement resets it.
    if (binding.terminal_id !== input.execution.terminalId)
      throw competingConnection();
    const differentChart =
      binding.instance_id && binding.instance_id !== input.instanceId;
    if (
      differentChart &&
      (!register || now - Number(binding.last_seen) <= chartLeaseMs)
    )
      throw competingConnection();
    if (!register && binding.session_id !== input.terminalSession)
      throw new ApiError(
        409,
        "Register this EA session before sending connection updates.",
        "EA_CONNECTION_REGISTRATION_REQUIRED",
      );
  } else if (!register)
    throw new ApiError(
      409,
      "Register this EA installation before sending connection updates.",
      "EA_CONNECTION_REGISTRATION_REQUIRED",
    );

  // Disconnected reports may suspend their own execution, but cannot take or
  // renew a chart lease. A subsequent successful registration claims it.
  if (!input.brokerConnected) return binding;

  await tx.query(
    "INSERT INTO rocket_ea_connection_binding(connection_id,installation_id,terminal_id,instance_id,session_id,last_seen) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET installation_id=excluded.installation_id,terminal_id=excluded.terminal_id,instance_id=excluded.instance_id,session_id=excluded.session_id,last_seen=excluded.last_seen",
    [
      cid,
      installation.id,
      input.execution.terminalId,
      instance,
      input.terminalSession,
      now,
    ],
  );
  return {
    connection_id: cid,
    installation_id: installation.id,
    terminal_id: input.execution.terminalId,
    instance_id: instance,
    session_id: input.terminalSession,
    last_seen: now,
  };
}
