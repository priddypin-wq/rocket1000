import { dashboardRequest } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { ordersDashboardService } from "../../../../server/orders-dashboard.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    ordersDashboardService(getDatabase()).status(uid),
  );
