import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "./errors.mjs";
import { ENGINE_VERSION } from "../lib/engine-version.mjs";
export const defaultTradeSettings = Object.freeze({
  strategy: "adaptive",
  tradingMode: "balanced",
  sizingMode: "adaptive",
  lotSize: 0.01,
  stopLossPoints: 500,
  takeProfitPoints: 1000,
  trailingStopPoints: 500,
  breakEvenPoints: 500,
  riskPerTradePct: 0.5,
  maxDailyLossPct: 5,
  maxDrawdownPct: 5,
  maxPositions: 3,
  minConfidence: 0.75,
  intervalSeconds: 60,
  maxSpreadPoints: 100,
  maxSlippagePoints: 10,
});
export function accountKey(login, server, type) {
  return createHash("sha256")
    .update(JSON.stringify([login, server, type]))
    .digest("hex");
}
export function validateTradeSettings(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((k) => !Object.hasOwn(defaultTradeSettings, k))
  )
    throw new ApiError(400, "Invalid risk settings.");
  const s = { ...defaultTradeSettings, ...value };
  if (!["adaptive", "price-action", "scalping"].includes(s.strategy))
    throw new ApiError(422, "Choose Adaptive AI, Price Action or Scalping.");
  if (!["balanced", "aggressive"].includes(s.tradingMode))
    throw new ApiError(422, "Choose Balanced or Aggressive trading mode.");
  if (!["adaptive", "capped"].includes(s.sizingMode))
    throw new ApiError(
      422,
      "Choose automatic balance sizing or a custom lot cap.",
    );
  const ranges = {
    lotSize: [0.00000001, 100],
    stopLossPoints: [1, 10000000],
    takeProfitPoints: [1, 10000000],
    trailingStopPoints: [0, 10000000],
    breakEvenPoints: [0, 10000000],
    riskPerTradePct: [0.1, 0.5],
    maxDailyLossPct: [0.1, 5],
    maxDrawdownPct: [0.1, 5],
    maxPositions: [1, 3],
    minConfidence: [0.5, 1],
    intervalSeconds: [60, 3600],
    maxSpreadPoints: [1, 1000],
    maxSlippagePoints: [1, 1000],
  };
  if (
    Object.entries(ranges).some(
      ([k, [lo, hi]]) => !Number.isFinite(s[k]) || s[k] < lo || s[k] > hi,
    ) ||
    !Number.isInteger(s.maxPositions) ||
    !Number.isInteger(s.intervalSeconds)
  )
    throw new ApiError(
      422,
      "Use positive broker sizes, up to 0.5% risk per trade, 5% daily loss/drawdown and three positions.",
    );
  return s;
}
export async function tradeSettings(tx, cid) {
  await tx.query(
    "INSERT INTO rocket_trade_preferences(connection_id,revision,payload) VALUES(?,?,?) ON CONFLICT(connection_id) DO NOTHING",
    [cid, randomUUID(), JSON.stringify(defaultTradeSettings)],
  );
  const [r] = await tx.query(
    "SELECT * FROM rocket_trade_preferences WHERE connection_id=?",
    [cid],
  );
  const saved = JSON.parse(r.payload);
  // The policy was tightened from 1%. Existing accounts retain any lower
  // preference while an old, higher preference cannot expand the new hard cap.
  if (Number.isFinite(saved?.riskPerTradePct))
    saved.riskPerTradePct = Math.min(0.5, saved.riskPerTradePct);
  return {
    settings: validateTradeSettings(saved),
    revision: r.revision,
  };
}
export async function freezeCommandAccounts(tx, cid) {
  const rows = await tx.query(
    "SELECT t.id,i.account_login,i.broker_server,i.account_type FROM rocket_trade_commands t JOIN rocket_direct_installations i ON i.id=t.installation_id LEFT JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.connection_id=? AND a.command_id IS NULL",
    [cid],
  );
  for (const r of rows)
    if (r.account_login && r.broker_server && r.account_type)
      await tx.query(
        "INSERT INTO rocket_command_accounts(command_id,account_key) VALUES(?,?) ON CONFLICT(command_id) DO NOTHING",
        [r.id, accountKey(r.account_login, r.broker_server, r.account_type)],
      );
}
export async function liveConsent(tx, c) {
  const key = accountKey(c.expected_login, c.expected_server, c.expected_type);
  const [consent] = await tx.query(
    "SELECT c.confirmed_at FROM rocket_live_consents c JOIN rocket_live_approvals a ON a.user_id=c.user_id AND a.account_key=c.account_key AND a.used_at=c.confirmed_at WHERE c.user_id=? AND c.account_key=? AND a.engine_version=? AND a.used_at IS NOT NULL LIMIT 1",
    [c.user_id, key, ENGINE_VERSION],
  );
  return {
    key,
    confirmed: !!consent,
    confirmedAt: consent ? Number(consent.confirmed_at) : null,
  };
}
