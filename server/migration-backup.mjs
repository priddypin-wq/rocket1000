import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { gzipSync } from "node:zlib";

// Logical rollback snapshot for additive releases, retained in the existing
// protected database. Encryption material stays in Vercel, outside the database.
// This supplements, and does not replace, the provider's disaster recovery.
export async function migrationBackup(db, env = process.env) {
  if (db.kind !== "postgres" || env.VERCEL !== "1") return null;
  const raw = env.ROCKET_OPENAI_ENCRYPTION_KEY || "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw)
    throw new Error("A separate valid migration encryption secret is required");
  await db.query(
    "CREATE TABLE IF NOT EXISTS rocket_release_backups (id TEXT PRIMARY KEY,created_at BIGINT NOT NULL,release TEXT NOT NULL,payload TEXT NOT NULL)",
  );
  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const tables = await tx.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'rocket_release_backups' ORDER BY table_name",
    );
    const snapshot = {
      createdAt: Date.now(),
      tables: [],
      columns: await tx.query(
        "SELECT table_name,column_name,data_type,udt_name,column_default,is_nullable,ordinal_position FROM information_schema.columns WHERE table_schema='public' AND table_name<>'rocket_release_backups' ORDER BY table_name,ordinal_position",
      ),
      constraints: await tx.query(
        "SELECT c.relname AS table_name,con.conname,pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'",
      ),
      indexes: await tx.query(
        "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'",
      ),
    };
    let size = 0;
    for (const { table_name: name } of tables) {
      const rows = await tx.query(
        `SELECT * FROM "${name.replaceAll('"', '""')}"`,
      );
      const serialized = JSON.stringify(rows);
      size += Buffer.byteLength(serialized);
      if (size > 50 * 1024 * 1024)
        throw new Error(
          "Migration backup exceeds the bounded snapshot size; use provider backup tooling",
        );
      snapshot.tables.push({ name, rows });
    }
    const id = randomUUID(),
      iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`rocket1000-migration:${id}`));
    const encrypted = Buffer.concat([
      cipher.update(gzipSync(Buffer.from(JSON.stringify(snapshot)))),
      cipher.final(),
    ]);
    const payload = JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64"),
    });
    await tx.query(
      "INSERT INTO rocket_release_backups(id,created_at,release,payload) VALUES(?,?,?,?)",
      [
        id,
        snapshot.createdAt,
        env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || "rocket-ai-5",
        payload,
      ],
    );
    return { id, tables: tables.length };
  });
}
