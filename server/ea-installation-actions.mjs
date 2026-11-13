// Stores request identities, never installation credentials or download bytes.
// The connection row is locked before checking or recording one of these actions.
export const eaInstallationActionsSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_ea_installation_actions (
    connection_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    format TEXT NOT NULL,
    reviewed_installation_id TEXT NOT NULL,
    result_installation_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY(connection_id,request_id),
    FOREIGN KEY(connection_id) REFERENCES rocket_direct_connections(id) ON DELETE CASCADE
  )`,
];
