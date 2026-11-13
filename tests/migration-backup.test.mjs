import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createDecipheriv } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { migrationBackup } from "../server/migration-backup.mjs";

test("pre-migration rollback snapshot is authenticated encryption, never plaintext", async () => {
  const key = randomBytes(32);
  let saved;
  const db = {
    kind: "postgres",
    transaction: (fn) => fn(db),
    query: async (sql, values) => {
      if (sql.includes("INSERT INTO rocket_release_backups")) {
        saved = values;
        return [];
      }
      if (sql.includes("information_schema.tables"))
        return [{ table_name: "rocket_private_fixture" }];
      if (sql.startsWith("SELECT * FROM"))
        return [{ private: "fixture-private-value" }];
      return [];
    },
  };
  const result = await migrationBackup(db, {
    VERCEL: "1",
    ROCKET_OPENAI_ENCRYPTION_KEY: key.toString("base64"),
    VERCEL_DEPLOYMENT_ID: "test-release",
  });
  assert.equal(result.tables, 1);
  assert.equal(saved[2], "test-release");
  assert.ok(!saved[3].includes("fixture-private-value"));
  assert.ok(!saved[3].includes(key.toString("base64")));
  const p = JSON.parse(saved[3]),
    decrypt = createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64"));
  decrypt.setAAD(Buffer.from(`rocket1000-migration:${result.id}`));
  decrypt.setAuthTag(Buffer.from(p.tag, "base64"));
  const snapshot = JSON.parse(
    gunzipSync(
      Buffer.concat([
        decrypt.update(Buffer.from(p.ciphertext, "base64")),
        decrypt.final(),
      ]),
    ),
  );
  assert.equal(snapshot.tables[0].rows[0].private, "fixture-private-value");
  assert.equal(snapshot.tables[0].name, "rocket_private_fixture");
});

test("hosted migration fails before writes without a separate encryption secret", async () => {
  let writes = 0;
  const db = {
    kind: "postgres",
    query: async () => {
      writes++;
    },
  };
  await assert.rejects(
    migrationBackup(db, { VERCEL: "1" }),
    /encryption secret/,
  );
  assert.equal(writes, 0);
  assert.equal(await migrationBackup({ kind: "sqlite" }, {}), null);
});
