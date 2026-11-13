import { ApiError } from "./errors.mjs";

// Bind a user action to the account/session actually displayed at the tap.
// Stop actions deliberately do not use this fence: stopping must always work.
export function assertRequestedAccount(current, input = {}) {
  for (const [requested, actual, pattern] of [
    ["expectedAccountKey", "accountKey", /^[a-f0-9]{64}$/],
    ["expectedInstallationId", "installationId", /^[a-f0-9-]{36}$/],
    ["expectedSessionId", "sessionId", /^[a-f0-9]{24,64}$/],
  ]) {
    if (input[requested] === undefined) continue;
    if (typeof input[requested] !== "string" || !pattern.test(input[requested]))
      throw new ApiError(
        400,
        "Invalid account verification context.",
        "ACCOUNT_CONTEXT_INVALID",
      );
    if (input[requested] !== current?.[actual])
      throw new ApiError(
        409,
        "The MT5 account or EA session changed. Refresh and review this action again.",
        "ACCOUNT_CONTEXT_CHANGED",
      );
  }
}

export function executionIdentity(ctx) {
  return {
    accountKey: ctx?.consent?.key || null,
    installationId: ctx?.i?.id || null,
    sessionId: ctx?.x?.session_id || null,
  };
}
