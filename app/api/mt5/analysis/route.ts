import { dashboardRequest } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { analysisService } from "../../../../server/analysis-service.mjs";
import { engineService } from "../../../../server/engine-service.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    analysisService(getDatabase()).status(uid),
  );
export const POST = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    engineService(getDatabase()).start(uid),
  );
