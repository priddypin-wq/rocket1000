import { getDatabase, migrateConnections } from "../server/database.mjs";
const db = getDatabase();
try {
  await migrateConnections(db);
  console.log(
    "Private browser-session and MT5 schema migrated. Legacy account records are preserved but unused.",
  );
} finally {
  await db.close();
}
