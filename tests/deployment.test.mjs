import { test } from "node:test";
import assert from "node:assert/strict";
import { health, verifyDeployment } from "../server/deployment.mjs";
import { migrateConnections } from "../server/database.mjs";
import { fixture } from "./helpers.mjs";
test("Generate verifies HTTPS against the same persistent server instance", async () => {
  const f = await fixture();
  try {
    const local = await health(f.db);
    await migrateConnections(f.db);
    assert.deepEqual(await health(f.db), local);
    const origin = () => "https://integration.example.test";
    const result = await verifyDeployment(f.db, {
      origin,
      fetcher: async (url, options) => {
        assert.equal(url, origin() + "/api/health");
        assert.equal(options.redirect, "error");
        assert.equal(options.cache, "no-store");
        return Response.json(local);
      },
    });
    assert.equal(result, origin());
    await assert.rejects(
      () =>
        verifyDeployment(f.db, {
          origin,
          fetcher: async () =>
            Response.json({ ...local, instanceId: "different-server" }),
        }),
      (e) => e.code === "DEPLOYMENT_MISMATCH",
    );
    for (const fetcher of [
      async () =>
        new Response("<html>Login</html>", {
          headers: { "Content-Type": "text/html" },
        }),
      async () => new Response("Denied", { status: 403 }),
      async () => {
        throw Error("network");
      },
    ]) {
      await assert.rejects(
        () => verifyDeployment(f.db, { origin, fetcher }),
        (e) => e.code === "DEPLOYMENT_UNREACHABLE",
      );
    }
  } finally {
    await f.db.close();
  }
});
