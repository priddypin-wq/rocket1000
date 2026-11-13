import { timingSafeEqual } from "node:crypto";
import { getDatabase } from "../../../../server/database.mjs";
import { engineService } from "../../../../server/engine-service.mjs";
import { handle } from "../../../../server/http.mjs";
import { ApiError } from "../../../../server/errors.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = (req: Request) =>
  handle(async () => {
    const secret = process.env.CRON_SECRET;
    const actual = Buffer.from(req.headers.get("authorization") || "");
    const expected = Buffer.from(`Bearer ${secret || ""}`);
    if (
      new URL(req.url).protocol !== "https:" ||
      !secret ||
      secret.length < 32 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new ApiError(401, "Scheduler authorization required.");
    const engine = engineService(getDatabase());
    await engine.heartbeat("cron", "protected-cron");
    // One bounded cycle per invocation, with persistent leases and no blind retry.
    return engine.drain({ limit: 1 });
  });
