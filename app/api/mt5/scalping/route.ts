import { dashboardRequest } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { autonomousStatusService } from "../../../../server/autonomous-status.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Compatibility dashboard name. All actions use the existing unified engine API.
export const GET = (req: Request) =>
  dashboardRequest(req, (_: unknown, uid: string) =>
    autonomousStatusService(getDatabase()).status(uid),
  );
