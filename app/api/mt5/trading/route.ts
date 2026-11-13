import { dashboardRequest, jsonInput } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { tradingService } from "../../../../server/trading.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) => {
    const service = tradingService(getDatabase());
    const commandId = new URL(req.url).searchParams.get("commandId");
    return commandId === null
      ? service.status(uid)
      : service.commandStatus(uid, commandId);
  });
export const POST = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    tradingService(getDatabase()).act(uid, await jsonInput(req)),
  );
