import { validateExecution } from "./trading.mjs";

export const CONNECTION_TIMEOUT_MS = 30000;

export function recentConnectionTimestamp(value, now) {
  const timestamp = Number(value);
  return (
    Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    timestamp <= now + 2000 &&
    now - timestamp <= CONNECTION_TIMEOUT_MS
  );
}

// Every dashboard reads the same authenticated connection. A connection status
// is distinct from permission to trade or freshness of a particular quote.
export function connectionHealth(connection, installation, executionRow, now) {
  const i = installation;
  const identity = !!(
    connection &&
    i?.registered_at &&
    i.account_login === connection.expected_login &&
    i.broker_server === connection.expected_server &&
    i.account_type === connection.expected_type
  );
  const lastHeartbeat = i?.last_heartbeat ? Number(i.last_heartbeat) : null;
  let execution = null;
  if (executionRow?.installation_id === i?.id) {
    try {
      const parsed = validateExecution(JSON.parse(executionRow.payload));
      if (
        /^[a-f0-9]{24,64}$/.test(executionRow.session_id || "") &&
        (parsed.protocol !== 4 || parsed.terminalId)
      )
        execution = parsed;
    } catch {
      // Malformed stored data must never advertise a healthy broker state.
    }
  }
  let status = "Disconnected";
  if (i) {
    if (
      i.revoked_at ||
      Number(i.expires_at) <= now ||
      i.last_error === "AUTHENTICATION_FAILED"
    )
      status = "Authentication Failed";
    else if (i.last_error === "ACCOUNT_MISMATCH") status = "Account Mismatch";
    else if (
      identity &&
      !i.last_error &&
      recentConnectionTimestamp(lastHeartbeat, now) &&
      (!executionRow ||
        (execution && recentConnectionTimestamp(executionRow.received_at, now)))
    )
      status = "Connected";
    else if (
      !i.registered_at &&
      !i.last_error &&
      recentConnectionTimestamp(i.created_at, now)
    )
      status = "Connecting";
  }
  return {
    status,
    fresh: status === "Connected",
    identity,
    lastHeartbeat,
    execution,
  };
}
