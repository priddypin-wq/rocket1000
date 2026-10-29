export function verifiedConnectionResponse(value, expectedId) {
  let url;
  try {
    url = new URL(value?.serverUrl);
  } catch {
    /* Fail closed below. */
  }
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value?.connectionId || "",
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
