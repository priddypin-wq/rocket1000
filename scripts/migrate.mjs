import { getDatabase, migrateConnections } from "../server/database.mjs";
import { migrationBackup } from "../server/migration-backup.mjs";
const db = getDatabase();
try {
  const backup = await migrationBackup(db);
  if (backup)
    console.log(
      `Encrypted pre-migration snapshot saved (${backup.tables} tables; reference ${backup.id}).`,
    );
  await migrateConnections(db);
  console.log(
    "Private browser-session and MT5 schema migrated. Legacy account records are preserved but unused.",
  );
} finally {
  await db.close();
}
