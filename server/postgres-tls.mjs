// Make the current certificate and hostname checks explicit before pg's
// legacy aliases change meaning. Keep credentials and other URL parameters.
export function verifiedPostgresUrl(
  connectionString,
  { required = false } = {},
) {
  const parsed = URL.parse(connectionString);
  if (!parsed || !["postgres:", "postgresql:"].includes(parsed.protocol)) {
    if (!required) return connectionString;
    throw Error(
      "Hosted PostgreSQL requires a valid PostgreSQL connection URL.",
    );
  }
  const modes = parsed.searchParams.getAll("sslmode");
  const legacyVerified = modes.some((mode) =>
    ["prefer", "require", "verify-ca"].includes(mode),
  );
  if (!required && !legacyVerified) return connectionString;
  parsed.searchParams.set("sslmode", "verify-full");
  // pg also consults the ssl option from the URL, and will read a supplied CA.
  parsed.searchParams.delete("ssl");
  return parsed.toString();
}
