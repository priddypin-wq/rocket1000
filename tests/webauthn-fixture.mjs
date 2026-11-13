import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
const hash = (value) => createHash("sha256").update(value).digest();
const serialize = (value) => Buffer.from(value).toString("base64url");
// In-memory WebAuthn authenticator fixture. The server uses its actual signature,
// origin, relying-party, challenge, user verification and counter validation.
export function authenticator(origin) {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = key.publicKey.export({ format: "jwk" });
  const credentialID = randomBytes(32);
  let userId;
  let counter = 0;
  function baseData(options, flags) {
    const bytes = Buffer.alloc(37);
    const rp = typeof options.rp === "object" ? options.rp.id : options.rpId;
    hash(rp).copy(bytes);
    bytes.writeUInt8(flags, 32);
    bytes.writeUInt32BE(counter, 33);
    return bytes;
  }
  function payload(options, type, clientOrigin = origin) {
    const clientData = Buffer.from(
      JSON.stringify({
        type,
        challenge: options.challenge,
        origin: clientOrigin,
      }),
    );
    const id = serialize(credentialID);
    return {
      clientData,
      value: {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: serialize(clientData) },
      },
    };
  }
  function register(options) {
    userId = options.user.id;
    const pk = isoCBOR.encode(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
    const authData = Buffer.concat([
      baseData(options, 0x45),
      Buffer.alloc(16),
      Buffer.from([0, credentialID.length]),
      credentialID,
      pk,
    ]);
    const attestation = isoCBOR.encode(
      new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const { value } = payload(options, "webauthn.create");
    value.response.attestationObject = serialize(attestation);
    value.response.transports = ["internal", "hybrid"];
    return value;
  }
  function login(options, { clientOrigin, userVerified = true } = {}) {
    counter++;
    const authData = baseData(options, userVerified ? 0x05 : 0x01);
    const { clientData, value } = payload(
      options,
      "webauthn.get",
      clientOrigin,
    );
    value.response.authenticatorData = serialize(authData);
    value.response.signature = serialize(
      sign(
        "sha256",
        Buffer.concat([authData, hash(clientData)]),
        key.privateKey,
      ),
    );
    value.response.userHandle = userId;
    return value;
  }
  return { register, login };
}
