import { dashboardRequest } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { ownerStatus } from "../../../../server/owner-status.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  dashboardRequest(request, (_service, _workspaceId, session) =>
    ownerStatus(getDatabase(), session),
  );
