import { ApiError, backendOrigin, compiledArtifact } from "./provisioning.mjs";
export async function health(db) {
  const [row] = await db.query(
    "SELECT value FROM rocket_server_meta WHERE name=?",
    ["instance_id"],
  );
  if (!row) throw new ApiError(503, "Server migrations are incomplete.");
  return { service: "rocket1000", protocol: 2, instanceId: row.value };
}
export async function verifyDeployment(
  db,
  { fetcher = fetch, origin = () => backendOrigin() } = {},
) {
  const url = origin();
  const local = await health(db);
  await compiledArtifact();
  let remote;
  try {
    const r = await fetcher(`${url}/api/health`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok || !r.headers.get("content-type")?.includes("application/json"))
      throw Error();
    remote = await r.json();
  } catch {
    throw new ApiError(
      503,
      "The configured HTTPS server is not reachable as a ROCKET1000 backend.",
      "DEPLOYMENT_UNREACHABLE",
    );
  }
  if (
    !remote ||
    remote.service !== "rocket1000" ||
    remote.protocol !== 2 ||
    remote.instanceId !== local.instanceId
  )
    throw new ApiError(
      503,
      "The HTTPS address does not match this backend.",
      "DEPLOYMENT_MISMATCH",
    );
  return url;
}
