import { dashboardRequest, jsonInput } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { tradingService } from "../../../../server/trading.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    tradingService(getDatabase()).status(uid),
  );
export const POST = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    tradingService(getDatabase()).act(uid, await jsonInput(req)),
  );
