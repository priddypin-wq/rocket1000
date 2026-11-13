import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sealEaCredential,
  unsealEaCredential,
} from "../server/ea-credential-vault.mjs";

const env = {
  ROCKET_OPENAI_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
};
const token = `r1000.01234567-89ab-4cde-8123-456789abcdef.${"x".repeat(43)}`;
const scope = ["fixture-owner", "fixture-connection", "fixture-installation"];

test("EA recovery vault stores randomized authenticated ciphertext, never the credential", () => {
  const a = sealEaCredential(token, ...scope, env),
    b = sealEaCredential(token, ...scope, env);
  assert.notEqual(a, b);
  assert.ok(!a.includes(token));
  assert.ok(!a.includes(env.ROCKET_OPENAI_ENCRYPTION_KEY));
  assert.equal(unsealEaCredential(a, ...scope, env), token);
});

for (const index of [0, 1, 2])
  test(`EA recovery vault rejects a different ${["workspace", "connection", "installation"][index]}`, () => {
    const sealed = sealEaCredential(token, ...scope, env),
      wrong = [...scope];
    wrong[index] += "-other";
    assert.throws(
      () => unsealEaCredential(sealed, ...wrong, env),
      (e) => e.code === "EA_CREDENTIAL_STORAGE_UNAVAILABLE",
    );
  });

test("EA recovery vault rejects tampering, wrong encryption keys and malformed ciphertext", () => {
  const sealed = sealEaCredential(token, ...scope, env);
  for (const field of ["nonce", "tag", "ciphertext"]) {
    const changed = JSON.parse(sealed),
      bytes = Buffer.from(changed[field], "base64");
    bytes[0] ^= 1;
    changed[field] = bytes.toString("base64");
    assert.throws(
      () => unsealEaCredential(JSON.stringify(changed), ...scope, env),
      (e) => e.code === "EA_CREDENTIAL_STORAGE_UNAVAILABLE",
    );
  }
  assert.throws(() =>
    unsealEaCredential(sealed, ...scope, {
      ROCKET_OPENAI_ENCRYPTION_KEY: Buffer.alloc(32, 14).toString("base64"),
    }),
  );
  for (const value of ["", "not-json", "{}", '{"v":2}'])
    assert.throws(() => unsealEaCredential(value, ...scope, env));
});

test("EA recovery vault fails closed without a separate canonical encryption secret", () => {
  for (const value of [
    undefined,
    "",
    "invalid",
    Buffer.alloc(16).toString("base64"),
    Buffer.alloc(32).toString("base64") + "\n",
  ]) {
    assert.throws(
      () =>
        sealEaCredential(token, ...scope, {
          ROCKET_OPENAI_ENCRYPTION_KEY: value,
        }),
      (e) => e.code === "EA_CREDENTIAL_STORAGE_UNAVAILABLE",
    );
  }
});
