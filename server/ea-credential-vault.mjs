import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ApiError } from "./errors.mjs";
export const eaCredentialSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_ea_download_credentials (installation_id TEXT PRIMARY KEY,sealed TEXT NOT NULL,FOREIGN KEY(installation_id) REFERENCES rocket_direct_installations(id) ON DELETE CASCADE)`,
];
const unavailable = () =>
  new ApiError(
    503,
    "Private EA download storage is unavailable. Check the server encryption secret; the installed EA credential has not been replaced.",
    "EA_CREDENTIAL_STORAGE_UNAVAILABLE",
  );
function key(env) {
  const text = env.ROCKET_OPENAI_ENCRYPTION_KEY;
  if (typeof text !== "string") throw unavailable();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== text)
    throw unavailable();
  return bytes;
}
function aad(uid, cid, id) {
  return Buffer.from(`ROCKET1000:EA-DOWNLOAD:1:${uid}:${cid}:${id}`);
}
export function sealEaCredential(token, uid, cid, id, env = process.env) {
  const secret = key(env);
  try {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", secret, nonce);
    cipher.setAAD(aad(uid, cid, id));
    const ciphertext = Buffer.concat([
      cipher.update(token, "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: 1,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  } finally {
    secret.fill(0);
  }
}
export function unsealEaCredential(sealed, uid, cid, id, env = process.env) {
  const secret = key(env);
  try {
    const p = JSON.parse(sealed);
    if (
      p.v !== 1 ||
      Buffer.from(p.nonce, "base64").length !== 12 ||
      Buffer.from(p.tag, "base64").length !== 16
    )
      throw Error();
    const cipher = createDecipheriv(
      "aes-256-gcm",
      secret,
      Buffer.from(p.nonce, "base64"),
    );
    cipher.setAAD(aad(uid, cid, id));
    cipher.setAuthTag(Buffer.from(p.tag, "base64"));
    return Buffer.concat([
      cipher.update(Buffer.from(p.ciphertext, "base64")),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw unavailable();
  } finally {
    secret.fill(0);
  }
}
