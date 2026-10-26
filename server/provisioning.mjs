import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { validateSnapshot } from "./market.mjs";
import { ApiError } from "./errors.mjs";
import { personalizedEaSource } from "./ea-source.mjs";
import { pauseActivation } from "./engine-activation.mjs";
import {
  sealEaCredential,
  unsealEaCredential,
} from "./ea-credential-vault.mjs";
import { freezeCommandAccounts } from "./trade-settings.mjs";
import { accountKey } from "./trade-settings.mjs";
import { synchronizeOwnedBrokerState } from "./orders-dashboard.mjs";
import {
  disableTrading,
  pauseForReconnect,
  revokeLiveActivation,
  executionExchange,
  tradingService,
} from "./trading.mjs";
export { ApiError } from "./errors.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ttl = 90 * 24 * 60 * 60 * 1000;
export const HEARTBEAT_TIMEOUT_MS = 90000;

// Never infer this from Host/X-Forwarded-Host or a submitted download URL.
export function backendOrigin(env = process.env) {
  try {
    const u = new URL(env.ROCKET_BACKEND_URL);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      u.port ||
      u.hostname === "localhost" ||
      !u.hostname.includes(".") ||
      /^[\d.]+$/.test(u.hostname) ||
      u.hostname.endsWith(".local")
    )
      throw Error();
    return u.origin;
  } catch {
    throw new ApiError(
      503,
      "EA downloads require a configured production HTTPS backend.",
      "BACKEND_NOT_CONFIGURED",
    );
  }
}

export async function compiledArtifact(root = process.cwd()) {
  try {
    const binary = await readFile(join(root, "ea", "ROCKET1000_EA.ex5"));
    const manifest = JSON.parse(
      await readFile(join(root, "ea", "build-manifest.json"), "utf8"),
    );
    const source = await readFile(join(root, "ea", "ROCKET1000_EA.mq5"));
    if (
      binary.length < 1024 ||
      sha(binary) !== manifest.binarySha256 ||
      sha(source) !== manifest.sourceSha256 ||
      manifest.errors !== 0 ||
      manifest.warnings !== 0
    )
      throw Error();
    return { binary, manifest, source };
  } catch {
    throw new ApiError(
      503,
      "The verified compiled EA is unavailable. Run the MetaEditor build before provisioning.",
      "EA_UNAVAILABLE",
    );
  }
}

export function provisioningService(
  db,
  {
    now = Date.now,
    artifact = compiledArtifact,
    origin = () => backendOrigin(),
    env = process.env,
  } = {},
) {
  const audit = (tx, uid, cid, event) =>
    tx.query(
      "INSERT INTO rocket_direct_audit(id,user_id,connection_id,event,created_at) VALUES(?,?,?,?,?)",
      [randomUUID(), uid, cid, event, now()],
    );
  async function owned(tx, uid, cid, lock = false) {
    if (typeof cid !== "string" || !uuid.test(cid))
      throw new ApiError(404, "Connection not found");
    const [c] = await tx.query(
      `SELECT * FROM rocket_direct_connections WHERE id=? AND user_id=?${lock && tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
      [cid, uid],
    );
    if (!c) throw new ApiError(404, "Connection not found");
    return c;
  }
  async function rateLimit(key, max = 60) {
    const bucket = Math.floor(now() / 60000);
    const [r] = await db.query(
      `INSERT INTO rocket_rate_limits(key,bucket,hits) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,hits=CASE WHEN rocket_rate_limits.bucket=excluded.bucket THEN rocket_rate_limits.hits+1 ELSE 1 END RETURNING hits`,
      [sha(key), bucket],
    );
    if (r.hits > max)
      throw new ApiError(429, "Too many requests. Try again shortly.");
  }
  async function create(uid) {
    return db.transaction(async (tx) => {
      const [owner] = await tx.query(
        `SELECT id FROM rocket_workspaces WHERE id=? AND expires_at>?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [uid, now()],
      );
      if (!owner) throw new ApiError(401, "Private browser session expired");
      const [existing] = await tx.query(
        "SELECT id FROM rocket_direct_connections WHERE user_id=?",
        [uid],
      );
      if (existing) return { id: existing.id };
      const id = randomUUID();
      await tx.query(
        "INSERT INTO rocket_direct_connections(id,user_id,label,created_at) VALUES(?,?,?,?)",
        [id, uid, "MT5 connection", now()],
      );
      await audit(tx, uid, id, "connection_created");
      return { id };
    });
  }
  async function download(
    uid,
    cid,
    { format = "package", replaceCredential = false } = {},
  ) {
    if (!["package", "source"].includes(format))
      throw new ApiError(400, "Unsupported EA download format.");
    if (typeof replaceCredential !== "boolean")
      throw new ApiError(400, "Invalid installation replacement choice.");
    // Check ownership before reading any artifact or issuing credentials.
    await owned(db, uid, cid);
    const [workspace] = await db.query(
      "SELECT expires_at FROM rocket_workspaces WHERE id=?",
      [uid],
    );
    const url = origin();
    const { binary, manifest, source } = await artifact();
    const createdAt = now();
    return db.transaction(async (tx) => {
      await owned(tx, uid, cid, true);
      const [previous] = await tx.query(
        "SELECT i.*,v.sealed FROM rocket_direct_installations i LEFT JOIN rocket_ea_download_credentials v ON v.installation_id=i.id WHERE i.connection_id=? AND i.revoked_at IS NULL AND i.expires_at>? ORDER BY i.created_at DESC LIMIT 1",
        [cid, createdAt],
      );
      if (previous && !previous.sealed && !replaceCredential)
        throw new ApiError(
          409,
          "Your existing EA credential is still active and has not been replaced. Reconnect that installation once to preserve it, or explicitly review replacing the EA installation.",
          "EA_ROTATION_REVIEW_REQUIRED",
        );
      const reuse = !!previous?.sealed && !replaceCredential;
      const id = reuse ? previous.id : randomUUID();
      const token = reuse
        ? unsealEaCredential(previous.sealed, uid, cid, id, env)
        : `r1000.${id}.${randomBytes(32).toString("base64url")}`;
      if (reuse && sha(token) !== previous.token_hash)
        throw new ApiError(
          503,
          "Stored EA download integrity check failed. No credential was changed.",
          "EA_CREDENTIAL_STORAGE_UNAVAILABLE",
        );
      const expiresAt = reuse
        ? Number(previous.expires_at)
        : Math.min(createdAt + ttl, Number(workspace.expires_at));
      if (expiresAt <= createdAt)
        throw new ApiError(401, "Private browser session expired");
      const config = `version=1\nbackend_url=${url}\ninstallation_id=${id}\ncredential=${token}\nexpires_at=${Math.floor(expiresAt / 1000)}\n`;
      const readme = `ROCKET1000 EA - personalized installation\n\n1. Keep this ZIP private: its config grants telemetry access to ONE installation.\n2. In MT5 choose File > Open Data Folder. Close/remove an older ROCKET1000 EA on all charts first.\n3. Copy MQL5 from this package into that data folder, merging its subfolders.\n   EA: MQL5/Experts/ROCKET1000/ROCKET1000_EA.ex5\n   Config: MQL5/Files/ROCKET1000/rocket1000.config\n   The files must stay in those locations; the EA loads the config automatically.\n4. Tools > Options > Expert Advisors: allow WebRequest for this exact address:\n   ${url}\n   This is an MT5 security permission, not an EA input or credential. Never disable TLS checks.\n5. Refresh Navigator and attach ROCKET1000 EA to ONE chart in the authorized account.\n   No token, URL, password or DLL input is needed. No dashboard account or email login is required. Algo Trading can remain OFF.\n6. Return to the dashboard and wait for verification.\n\nThe EA verifies the MT5 account, broker server and Demo/Live type. Switching accounts re-registers the new identity, stops automation and cancels old queued orders. Start again only after reviewing the new account.\nRepeated downloads preserve the active credential. Revoke EA access explicitly before replacing a lost installation.\nCredential expires: ${new Date(expiresAt).toISOString()}\nOrders are DISABLED by default. Account & settings offers Start AI trading after broker and risk checks pass. START AI verifies the real OpenAI connection and binds execution to the authenticated broker account. Demo and Live use the same workflow. A temporary reconnect may resume an already-enabled session for the same account and terminal; STOP and Emergency Stop never resume automatically.\nThe terminal must be logged into its broker to register.\nUse a separate MT5 data folder/terminal for each concurrent connection.\nThis package does not contain MT5 passwords, OpenAI keys, or dashboard session secrets.\nBuild source SHA-256: ${manifest.sourceSha256}\n`;
      const archive =
        format === "source"
          ? strToU8(
              personalizedEaSource({
                source,
                serverUrl: url,
                installationId: id,
                credential: token,
                expiresAt,
              }),
            )
          : zipSync(
              {
                "MQL5/Experts/ROCKET1000/ROCKET1000_EA.ex5": binary,
                "MQL5/Files/ROCKET1000/rocket1000.config": strToU8(config),
                "INSTALL.txt": strToU8(readme),
              },
              { level: 6 },
            );
      // Commit only after the package is fully assembled. Failed generation cannot revoke a working EA.
      if (reuse) {
        await audit(tx, uid, cid, "ea_download_existing_credential_preserved");
        return archive;
      }
      const sealed = sealEaCredential(token, uid, cid, id, env);
      await disableTrading(tx, cid, createdAt);
      await tx.query(
        "UPDATE rocket_direct_installations SET revoked_at=? WHERE connection_id=? AND revoked_at IS NULL",
        [createdAt, cid],
      );
      await tx.query(
        "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
        [cid],
      );
      await tx.query(
        "INSERT INTO rocket_direct_installations(id,connection_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
        [id, cid, sha(token), createdAt, expiresAt],
      );
      await audit(tx, uid, cid, "credential_issued_previous_revoked");
      await tx.query(
        "INSERT INTO rocket_ea_download_credentials(installation_id,sealed) VALUES(?,?)",
        [id, sealed],
      );
      return archive;
    });
  }
  function publicInstallation(i) {
    if (!i) return null;
    return {
      id: i.id,
      expiresAt: Number(i.expires_at),
      revokedAt: i.revoked_at === null ? null : Number(i.revoked_at),
      accountLogin: i.registered_at ? i.account_login : null,
      brokerServer: i.registered_at ? i.broker_server : null,
      accountType: i.registered_at ? i.account_type : null,
      lastHeartbeat: i.last_heartbeat ? Number(i.last_heartbeat) : null,
      lastError: i.last_error,
    };
  }
  async function list(uid) {
    const cs = await db.query(
      "SELECT * FROM rocket_direct_connections WHERE user_id=? ORDER BY created_at DESC",
      [uid],
    );
    return Promise.all(
      cs.map(async (c) => {
        const [i] = await db.query(
          "SELECT * FROM rocket_direct_installations WHERE connection_id=? ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 1",
          [c.id],
        );
        let status = "Disconnected";
        if (i) {
          if (
            i.revoked_at ||
            Number(i.expires_at) <= now() ||
            i.last_error === "AUTHENTICATION_FAILED"
          )
            status = "Authentication Failed";
          else if (i.last_error === "ACCOUNT_MISMATCH")
            status = "Account Mismatch";
          else if (
            i.last_heartbeat &&
            now() - Number(i.last_heartbeat) <= HEARTBEAT_TIMEOUT_MS
          )
            status = "Connected";
          else if (
            !i.registered_at &&
            now() - Number(i.created_at) <= HEARTBEAT_TIMEOUT_MS
          )
            status = "Connecting";
        }
        return {
          id: c.id,
          label: c.label,
          expectedLogin: c.expected_login,
          expectedServer: c.expected_server,
          expectedType: c.expected_type,
          status,
          tradingEnabled: (await tradingService(db, { now }).status(uid))
            .enabled,
          stopped: !!c.stopped,
          installation: publicInstallation(i),
        };
      }),
    );
  }
  async function revoke(uid, cid) {
    await db.transaction(async (tx) => {
      await owned(tx, uid, cid, true);
      await disableTrading(tx, cid, now());
      await tx.query(
        "UPDATE rocket_direct_installations SET revoked_at=? WHERE connection_id=? AND revoked_at IS NULL",
        [now(), cid],
      );
      await tx.query(
        "UPDATE rocket_direct_connections SET stopped=1 WHERE id=?",
        [cid],
      );
      await audit(tx, uid, cid, "credentials_revoked");
    });
  }
  async function stop(uid) {
    await db.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE user_id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [uid],
      );
      await tx.query(
        "UPDATE rocket_direct_connections SET stopped=1 WHERE user_id=?",
        [uid],
      );
      await revokeLiveActivation(tx, uid, now());
      for (const c of rows)
        await tx.query(
          "UPDATE rocket_analyses SET status=?,completed_at=? WHERE connection_id=? AND status=?",
          ["cancelled", now(), c.id, "analyzing"],
        );
      for (const c of rows) {
        await pauseActivation(tx, c.id, "Emergency Stop activated.");
        await tx.query(
          "UPDATE rocket_analysis_engine SET state='stopped',run_id=?,lease_until=0,reason='Emergency Stop activated.' WHERE connection_id=?",
          [randomUUID(), c.id],
        );
        await disableTrading(tx, c.id, now());
        await audit(
          tx,
          uid,
          c.id,
          "emergency_stop_all_live_permissions_revoked",
        );
      }
    });
  }
  async function telemetry(token, input, register, options = {}) {
    if (
      typeof token !== "string" ||
      token.length > 160 ||
      !/^r1000\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)
    )
      throw new ApiError(401, "Credential rejected", "AUTHENTICATION_FAILED");
    const id = token.split(".")[1];
    const result = await db.transaction(async (tx) => {
      const [i] = await tx.query(
        `SELECT i.*,c.user_id,c.expected_login,c.expected_server,c.expected_type FROM rocket_direct_installations i JOIN rocket_direct_connections c ON c.id=i.connection_id WHERE i.id=?${tx.kind === "postgres" ? " FOR UPDATE OF i,c" : ""}`,
        [id],
      );
      // An unauthenticated attacker must not be able to change another installation's status.
      if (
        !i ||
        !timingSafeEqual(
          Buffer.from(i.token_hash, "hex"),
          Buffer.from(sha(token), "hex"),
        )
      )
        return { error: [401, "Credential rejected", "AUTHENTICATION_FAILED"] };
      if (i.revoked_at || Number(i.expires_at) <= now()) {
        await disableTrading(tx, i.connection_id, now());
        await tx.query(
          "UPDATE rocket_direct_installations SET last_error=?,last_error_at=? WHERE id=?",
          ["AUTHENTICATION_FAILED", now(), id],
        );
        return {
          error: [
            401,
            "Credential expired or revoked",
            "AUTHENTICATION_FAILED",
          ],
        };
      }
      if (
        !input ||
        typeof input !== "object" ||
        typeof input.accountLogin !== "string" ||
        !/^\d{1,19}$/.test(input.accountLogin) ||
        BigInt(input.accountLogin) <= 0n ||
        BigInt(input.accountLogin) > 9223372036854775807n ||
        typeof input.brokerServer !== "string" ||
        input.brokerServer.length > 100 ||
        !input.brokerServer.trim() ||
        /[\u0000-\u001f\u007f]/u.test(input.brokerServer) ||
        !["demo", "live"].includes(input.accountType) ||
        (input.accountTradeMode !== undefined &&
          !(
            (input.accountTradeMode === 0 && input.accountType === "demo") ||
            (input.accountTradeMode === 2 && input.accountType === "live")
          )) ||
        !Number.isInteger(input.terminalBuild) ||
        input.terminalBuild < 1 ||
        typeof input.brokerConnected !== "boolean"
      )
        throw new ApiError(400, "Invalid terminal telemetry");
      if (
        i.expected_login !== null &&
        (input.accountLogin !== i.expected_login ||
          input.brokerServer !== i.expected_server ||
          input.accountType !== i.expected_type)
      ) {
        if (input.eaProtocol === 4 && register && input.brokerConnected) {
          await freezeCommandAccounts(tx, i.connection_id);
          await disableTrading(tx, i.connection_id, now());
          await tx.query(
            "UPDATE rocket_analysis_engine SET state='stopped',run_id=?,lease_until=0,reason='MT5 account changed; waiting for automatic verification.' WHERE connection_id=?",
            [randomUUID(), i.connection_id],
          );
          await tx.query(
            "UPDATE rocket_engine_activation SET generation=?,lease_until=0,next_attempt=0,reason=CASE WHEN paused=1 THEN reason ELSE 'Verifying the newly connected broker account.' END WHERE connection_id=?",
            [randomUUID(), i.connection_id],
          );
          await revokeLiveActivation(tx, i.user_id, now());
          await tx.query(
            "DELETE FROM rocket_market_snapshots WHERE connection_id=?",
            [i.connection_id],
          );
          await tx.query("DELETE FROM rocket_execution WHERE connection_id=?", [
            i.connection_id,
          ]);
          await tx.query(
            "DELETE FROM rocket_order_previews WHERE connection_id=?",
            [i.connection_id],
          );
          await tx.query(
            "UPDATE rocket_analyses SET status='cancelled',result=NULL,error='MT5 account changed',completed_at=? WHERE connection_id=?",
            [now(), i.connection_id],
          );
          await tx.query(
            "UPDATE rocket_direct_connections SET expected_login=?,expected_server=?,expected_type=? WHERE id=?",
            [
              input.accountLogin,
              input.brokerServer,
              input.accountType,
              i.connection_id,
            ],
          );
          i.expected_login = input.accountLogin;
          i.expected_server = input.brokerServer;
          i.expected_type = input.accountType;
          await audit(
            tx,
            i.user_id,
            i.connection_id,
            "mt5_account_switched_automation_stopped",
          );
        } else {
          if (i.last_error !== "ACCOUNT_MISMATCH")
            await audit(tx, i.user_id, i.connection_id, "account_mismatch");
          await disableTrading(tx, i.connection_id, now());
          await tx.query(
            "UPDATE rocket_direct_installations SET last_error=?,last_error_at=? WHERE id=?",
            ["ACCOUNT_MISMATCH", now(), id],
          );
          return {
            error: [
              403,
              "MT5 account or broker server is not authorized",
              "ACCOUNT_MISMATCH",
            ],
          };
        }
      }
      if (!input.brokerConnected) {
        await pauseForReconnect(tx, i.connection_id, now());
        await tx.query(
          "UPDATE rocket_direct_installations SET last_heartbeat=NULL,last_error=NULL,last_error_at=NULL WHERE id=?",
          [id],
        );
        return {
          error: [
            409,
            "Broker connection is unavailable",
            "BROKER_DISCONNECTED",
          ],
        };
      }
      if (!register && !i.registered_at)
        return {
          error: [
            409,
            "Register this installation first",
            "REGISTRATION_REQUIRED",
          ],
        };
      if (i.expected_login === null) {
        await tx.query(
          "UPDATE rocket_direct_connections SET expected_login=?,expected_server=?,expected_type=? WHERE id=?",
          [
            input.accountLogin,
            input.brokerServer,
            input.accountType,
            i.connection_id,
          ],
        );
        await audit(tx, i.user_id, i.connection_id, "mt5_account_bound");
      }
      if (!i.registered_at)
        await audit(tx, i.user_id, i.connection_id, "ea_registered");
      // One active chart is supported by this execution engine. Its exact broker
      // symbol is registered by the authenticated EA, never chosen by a browser.
      const reportedSymbol = input.chartSymbol ?? input.market?.symbol;
      if (reportedSymbol !== undefined) {
        if (
          typeof reportedSymbol !== "string" ||
          !/^\S{1,40}$/.test(reportedSymbol) ||
          (input.chartSymbol !== undefined &&
            (!Array.isArray(input.authorizedSymbols) ||
              input.authorizedSymbols.length !== 1 ||
              input.authorizedSymbols[0] !== reportedSymbol ||
              typeof input.instanceId !== "string" ||
              !/^[a-f0-9]{24,64}$/.test(input.instanceId))) ||
          (input.market && input.market.symbol !== reportedSymbol)
        )
          throw new ApiError(
            422,
            "The authenticated EA must report one exact chart symbol.",
            "SYMBOL_REGISTRATION_INVALID",
          );
        const key = accountKey(
          input.accountLogin,
          input.brokerServer,
          input.accountType,
        );
        const [symbol] = await tx.query(
          "SELECT * FROM rocket_ea_symbols WHERE connection_id=?",
          [i.connection_id],
        );
        if (
          !register &&
          symbol &&
          (symbol.installation_id !== id ||
            symbol.account_key !== key ||
            symbol.symbol !== reportedSymbol ||
            (input.instanceId &&
              symbol.instance_id &&
              input.instanceId !== symbol.instance_id))
        ) {
          await disableTrading(tx, i.connection_id, now());
          return {
            error: [
              409,
              "The EA chart or terminal changed. Register it again before trading.",
              "SYMBOL_REGISTRATION_REQUIRED",
            ],
          };
        }
        if (register && symbol?.symbol !== reportedSymbol)
          await tx.query(
            "DELETE FROM rocket_market_snapshots WHERE connection_id=?",
            [i.connection_id],
          );
        await tx.query(
          "INSERT INTO rocket_ea_symbols(connection_id,installation_id,session_id,account_key,symbol,instance_id,received_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET installation_id=excluded.installation_id,session_id=excluded.session_id,account_key=excluded.account_key,symbol=excluded.symbol,instance_id=excluded.instance_id,received_at=excluded.received_at",
          [
            i.connection_id,
            id,
            input.terminalSession || "",
            key,
            reportedSymbol,
            input.instanceId || null,
            now(),
          ],
        );
      }
      if (input.market !== undefined) {
        const snapshot = validateSnapshot(input.market, now());
        await tx.query(
          "INSERT INTO rocket_market_snapshots(connection_id,installation_id,payload,received_at) VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET installation_id=excluded.installation_id,payload=excluded.payload,received_at=excluded.received_at",
          [i.connection_id, id, JSON.stringify(snapshot), now()],
        );
      }
      await tx.query(
        "UPDATE rocket_direct_installations SET registered_at=COALESCE(registered_at,?),last_heartbeat=?,last_error=NULL,last_error_at=NULL,account_login=?,broker_server=?,account_type=?,terminal_build=? WHERE id=?",
        [
          now(),
          now(),
          input.accountLogin,
          input.brokerServer,
          input.accountType,
          input.terminalBuild,
          id,
        ],
      );
      const exchange = await executionExchange(tx, i, input, now(), {
        register,
        ...options,
      });
      await synchronizeOwnedBrokerState(tx, i, input, now());
      // A legacy installation stored only a hash. A genuinely authenticated
      // heartbeat can backfill its own token into the scoped encrypted vault;
      // never rotate an existing valid credential merely to enable downloads.
      const [vault] = await tx.query(
        "SELECT installation_id FROM rocket_ea_download_credentials WHERE installation_id=?",
        [id],
      );
      if (!vault) {
        let sealed;
        try {
          sealed = sealEaCredential(token, i.user_id, i.connection_id, id, env);
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.code !== "EA_CREDENTIAL_STORAGE_UNAVAILABLE"
          )
            throw error;
          // Storage configuration must not invalidate a legitimate installed EA.
        }
        if (sealed)
          await tx.query(
            "INSERT INTO rocket_ea_download_credentials(installation_id,sealed) VALUES(?,?) ON CONFLICT(installation_id) DO NOTHING",
            [id, sealed],
          );
      }
      return {
        ok: true,
        installationId: id,
        heartbeatSeconds: input.eaProtocol === 4 ? 5 : 20,
        serverTime: now(),
        ...exchange,
      };
    });
    if (result.error) throw new ApiError(...result.error);
    return result;
  }
  async function logs(uid) {
    return db.query(
      'SELECT connection_id AS "connectionId",event,created_at AS "createdAt" FROM rocket_direct_audit WHERE user_id=? ORDER BY created_at DESC LIMIT 50',
      [uid],
    );
  }
  return { create, list, download, revoke, stop, telemetry, logs, rateLimit };
}
