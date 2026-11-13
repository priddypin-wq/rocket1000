const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function verifiedConnectionResponse(value, expectedId) {
  let url;
  try {
    url = new URL(value?.serverUrl);
  } catch {
    /* Fail closed below. */
  }
  if (
    !uuid.test(value?.connectionId || "") ||
    !(
      value?.installationId === null || uuid.test(value?.installationId || "")
    ) ||
    (expectedId && value.connectionId !== expectedId) ||
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !Number.isSafeInteger(value.verifiedAt) ||
    value.verifiedAt <= 0
  )
    throw Error(
      "The server did not verify this existing HTTPS connection. No connection success was confirmed.",
    );
  return value;
}

export function confirmedRevocation(value, connectionId, installationId) {
  if (
    value?.ok !== true ||
    value.connectionId !== connectionId ||
    value.installationId !== installationId ||
    !Number.isSafeInteger(value.revokedAt) ||
    value.revokedAt <= 0
  )
    throw Error(
      "The server did not confirm revocation of this EA installation.",
    );
  return value.revokedAt;
}

export function confirmedOpenAiAction(value, action) {
  if (
    typeof value?.configured !== "boolean" ||
    (action === "save" &&
      (value.configured !== true || value.stored !== true)) ||
    (action === "remove" &&
      (value.configured !== false || value.stored !== false))
  )
    throw Error(
      "The server did not confirm the OpenAI configuration change. Refresh its status before retrying.",
    );
  return value;
}
