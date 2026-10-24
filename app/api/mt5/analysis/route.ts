import { dashboardRequest } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { analysisService } from "../../../../server/analysis-service.mjs";
import { analysisQueue } from "../../../../server/analysis-queue.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    analysisService(getDatabase()).status(uid),
  );
export const POST = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    analysisQueue(getDatabase()).start(uid),
  );
