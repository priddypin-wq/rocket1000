const commandId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Read only in click handlers/timers, never while rendering a component.
export const monotonicEventTime = () => performance.now();

export function closeReviewFromResponse(result, context) {
  const { account, accountKey, position, serverTime, started } = context;
  const reviewedAccount = result?.account;
  const remaining = result?.expiresAt - (result?.serverTime ?? serverTime);
  if (
    !commandId.test(result?.id || "") ||
    result?.order?.kind !== "CLOSE" ||
    result.order.position !== position.ticket ||
    result.order.symbol !== position.symbol ||
    !Number.isFinite(result.order.volume) ||
    result.order.volume <= 0 ||
    result.order.volume > position.volume + 1e-8 ||
    !account ||
    !reviewedAccount ||
    reviewedAccount.login !== account.login ||
    reviewedAccount.server !== account.server ||
    reviewedAccount.type !== account.type ||
    reviewedAccount.login !== position.account.login ||
    reviewedAccount.server !== position.account.server ||
    reviewedAccount.type !== position.account.type ||
    result.accountKey !== accountKey ||
    !commandId.test(result.installationId || "") ||
    !/^[a-f0-9]{24,64}$/.test(result.sessionId || "") ||
    !Number.isFinite(remaining) ||
    remaining <= 0 ||
    !Number.isFinite(started)
  )
    throw new Error(
      "The close review expired or its account, position or EA connection changed. Refresh and review again.",
    );
  return {
    ...result,
    receivedAt: started,
    validFor: Math.min(60_000, remaining),
    accountKey,
    ticket: position.ticket,
  };
}

export function commandIsPending(status) {
  return ["queued", "claimed", "sending", "uncertain"].includes(status);
}

export function closeHasBrokerConfirmation(command) {
  const result = command?.result;
  return !!(
    ["partial", "executed"].includes(command?.status) &&
    result &&
    ([10009, 10010].includes(result.retcode) ||
      (result.retcode === 0 &&
        result.reconciled === true &&
        result.evidence === "broker-history")) &&
    typeof result.deal === "string" &&
    /^[1-9]\d{0,19}$/.test(result.deal) &&
    Number.isFinite(result.filledVolume) &&
    result.filledVolume > 0 &&
    Number.isFinite(result.filledPrice) &&
    result.filledPrice > 0
  );
}

export function closeNeedsReconciliation(command) {
  return (
    commandIsPending(command?.status) ||
    (["executed", "partial"].includes(command?.status) &&
      !closeHasBrokerConfirmation(command))
  );
}

export function closeCommandFeedback(command) {
  if (!commandId.test(command?.id || ""))
    throw new Error("The server did not confirm a close request identifier.");
  switch (command.status) {
    case "queued":
      return "Close request queued. Waiting for the authenticated EA and broker confirmation.";
    case "claimed":
      return "EA received the close request. Final execution checks are pending.";
    case "sending":
      return "Close request sent to the broker. Waiting for confirmed execution.";
    case "partial":
      return closeHasBrokerConfirmation(command)
        ? "Broker confirmed a partial close. Remaining position volume is reconciled from MT5."
        : "Partial close reported. Waiting for verified broker execution details.";
    case "executed":
      return closeHasBrokerConfirmation(command)
        ? "Broker confirmed close execution. Position state is refreshed from MT5."
        : "Execution reported. Waiting for verified broker execution details.";
    case "failed":
      return `Broker rejected the close request${Number.isInteger(command.result?.retcode) ? ` (MT5 code ${command.result.retcode})` : ""}. The position has not been marked closed.`;
    case "cancelled":
      return "Close request cancelled. Refresh the broker position before reviewing again.";
    case "expired":
      return "Close request expired. Refresh the broker position before reviewing again.";
    case "uncertain":
      return "Close outcome unknown. Checking broker reconciliation; do not submit a replacement.";
    default:
      throw new Error(
        "Close request status is unavailable. Check MT5 before retrying.",
      );
  }
}
