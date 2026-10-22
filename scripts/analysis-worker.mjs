import { getDatabase, migrateConnections } from "../server/database.mjs";
import { engineService } from "../server/engine-service.mjs";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
// Run as a supervised service, separately from a serverless web request.
// Production shares the existing PostgreSQL database with the web/EA backend.
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL)
  throw new Error(
    "The production worker requires the shared PostgreSQL DATABASE_URL.",
  );
const db = getDatabase();
await migrateConnections(db);
const engine = engineService(db);
const instanceId = `worker:${randomUUID()}`;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
console.log(
  "ROCKET1000 persistent analysis worker started. No trading permission is granted by this process.",
);
while (!stopping) {
  try {
    await engine.heartbeat("worker", instanceId);
    await engine.drain({ limit: 1 });
  } catch {
    console.error(
      "ROCKET1000 scheduler cycle failed. Retrying scheduler discovery; no broker command was retried.",
    );
  }
  if (!stopping) await setTimeout(5000);
}
await db.query("DELETE FROM rocket_engine_scheduler WHERE id=?", [instanceId]);
await db.close();
