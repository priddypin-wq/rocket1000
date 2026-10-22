import { ENGINE_VERSION } from "../lib/engine-version.mjs";
import { accountKey } from "./trade-settings.mjs";

export async function demoValidation(tx, uid) {
  const [row] = await tx.query(
    "SELECT completed_at FROM rocket_engine_validation WHERE user_id=? AND engine_version=?",
    [uid, ENGINE_VERSION],
  );
  return {
    passed: !!row,
    engineVersion: ENGINE_VERSION,
    completedAt: row ? Number(row.completed_at) : null,
  };
}

// Only the credential-verified broker acknowledgement path calls this. Browser requests
// cannot manufacture an acceptance record or mark a Demo test complete.
export async function recordDemoValidation(tx, cid, uid, key, now) {
  const [connection] = await tx.query(
    "SELECT user_id,expected_login,expected_server,expected_type FROM rocket_direct_connections WHERE id=?",
    [cid],
  );
  if (
    !connection ||
    connection.user_id !== uid ||
    connection.expected_type !== "demo" ||
    accountKey(
      connection.expected_login,
      connection.expected_server,
      "demo",
    ) !== key
  )
    return;
  if ((await demoValidation(tx, uid)).passed) return;
  const rows = await tx.query(
    "SELECT t.id,t.payload,t.result,t.status,t.created_at FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.connection_id=? AND a.account_key=? AND t.status IN ('executed','partial') ORDER BY t.created_at DESC LIMIT 500",
    [cid, key],
  );
  const commands = rows.map((r) => ({
    ...r,
    order: JSON.parse(r.payload),
    fill: JSON.parse(r.result || "null"),
  }));
  for (const open of commands) {
    if (
      open.order.kind !== "OPEN" ||
      open.order.source !== "ai" ||
      open.order.manualReview === true ||
      open.order.engineVersion !== ENGINE_VERSION ||
      !open.order.analysisId ||
      !open.fill?.filledVolume ||
      !open.fill?.filledPrice ||
      !open.fill?.deal ||
      open.fill.deal === "0"
    )
      continue;
    const [analysis] = await tx.query(
      "SELECT result FROM rocket_analyses WHERE id=? AND connection_id=? AND status='completed'",
      [open.order.analysisId, cid],
    );
    const assessment = analysis?.result ? JSON.parse(analysis.result) : null;
    if (
      assessment?.engineVersion !== ENGINE_VERSION ||
      assessment.model !== "gpt-6.1-sol" ||
      typeof assessment.responseId !== "string" ||
      !assessment.responseId ||
      assessment.decision !== open.order.side ||
      !["BUY", "SELL"].includes(assessment.decision)
    )
      continue;
    const comment = "R1000:" + open.id.slice(0, 24);
    const close = commands.find(
      (c) =>
        c.status === "executed" &&
        c.order.kind === "CLOSE" &&
        c.order.source === "ai" &&
        c.order.manualReview !== true &&
        c.order.engineVersion === ENGINE_VERSION &&
        c.order.positionComment === comment &&
        c.order.symbol === open.order.symbol &&
        c.order.side === open.order.side &&
        typeof c.order.position === "string" &&
        c.order.position !== "0" &&
        typeof c.order.positionIdentifier === "string" &&
        c.order.positionIdentifier !== "0" &&
        Number(c.created_at) > Number(open.created_at) &&
        c.fill?.deal &&
        c.fill.deal !== "0" &&
        c.fill.filledPrice > 0 &&
        !c.fill.partial &&
        c.fill.retcode !== 10010 &&
        Math.abs(c.fill.filledVolume - open.fill.filledVolume) <= 1e-8,
    );
    if (!close) continue;
    const modification = commands.find(
      (c) =>
        c.status === "executed" &&
        c.order.kind === "MODIFY" &&
        c.order.source === "ai" &&
        c.order.manualReview !== true &&
        c.order.engineVersion === ENGINE_VERSION &&
        c.order.positionIdentifier === close.order.positionIdentifier &&
        c.order.position === close.order.position &&
        c.order.symbol === open.order.symbol &&
        c.order.side === open.order.side &&
        c.order.positionComment === comment &&
        Number(c.created_at) > Number(open.created_at) &&
        Number(c.created_at) < Number(close.created_at),
    );
    if (!modification) continue;
    await tx.query(
      "INSERT INTO rocket_engine_validation(user_id,engine_version,completed_at,evidence) VALUES(?,?,?,?) ON CONFLICT(user_id,engine_version) DO NOTHING",
      [
        uid,
        ENGINE_VERSION,
        now,
        JSON.stringify({
          accountKey: key,
          open: open.id,
          modify: modification.id,
          close: close.id,
          analysisId: open.order.analysisId,
        }),
      ],
    );
    return;
  }
}
