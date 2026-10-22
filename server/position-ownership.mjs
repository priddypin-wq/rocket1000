// A magic number alone never establishes ownership. The connected EA must
// verify the entire broker position lineage and its original OPEN command.
export async function markManagedPositions(tx, cid, key, positions) {
  for (const position of positions) {
    position.managed = false;
    const prefix =
      position.magic === 100061 &&
      position.comment?.match(/^R1000:([a-f0-9-]{24})$/)?.[1];
    if (
      !prefix ||
      !position.ticket ||
      !position.identifier ||
      !position.ownedIntegrity
    )
      continue;
    const rows = await tx.query(
      "SELECT t.id,t.payload FROM rocket_trade_commands t JOIN rocket_command_accounts a ON a.command_id=t.id WHERE t.connection_id=? AND a.account_key=? AND t.id LIKE ?",
      [cid, key, prefix + "%"],
    );
    if (rows.length !== 1) continue;
    const origin = JSON.parse(rows[0].payload);
    position.managed =
      (origin.kind || "OPEN") === "OPEN" && origin.symbol === position.symbol;
  }
  return positions;
}

export async function hasManagedOrigin(tx, cid, key, value) {
  const position = {
    ...value,
    ticket: value.ticket,
    identifier: value.positionIdentifier,
    comment: value.originComment,
  };
  await markManagedPositions(tx, cid, key, [position]);
  return position.managed;
}
