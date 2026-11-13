import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { verifiedPostgresUrl } from "../server/postgres-tls.mjs";

test("hosted PostgreSQL uses verified TLS without changing credentials or connection options", () => {
  const base =
    "postgresql://fixture:escaped%40password@postgres.example.test:5433/rocket?application_name=rocket1000&channel_binding=require";
  for (const query of [
    "",
    "&sslmode=require",
    "&sslmode=verify-ca&uselibpqcompat=true",
    "&sslmode=disable&ssl=0",
    "&sslmode=no-verify&sslmode=prefer",
  ]) {
    const url = verifiedPostgresUrl(base + query, { required: true });
    const client = new pg.Client({ connectionString: url });
    const parameters = client.connectionParameters;
    assert.equal(parameters.host, "postgres.example.test");
    assert.equal(parameters.port, 5433);
    assert.equal(parameters.password, "escaped@password");
    assert.equal(parameters.application_name, "rocket1000");
    assert.equal(new URL(url).searchParams.get("channel_binding"), "require");
    assert.equal(new URL(url).searchParams.get("sslmode"), "verify-full");
    assert.ok(parameters.ssl);
    assert.notEqual(parameters.ssl.rejectUnauthorized, false);
    assert.equal(parameters.ssl.checkServerIdentity, undefined);
  }
});

test("local development can use an intentionally non-TLS PostgreSQL instance", () => {
  const local = "postgresql://fixture@localhost/rocket?sslmode=disable";
  assert.equal(verifiedPostgresUrl(local), local);
  assert.throws(
    () => verifiedPostgresUrl("not-a-url", { required: true }),
    /valid PostgreSQL/,
  );
});
