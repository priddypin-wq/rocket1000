import { dashboardRequest } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import {
  privateReportService,
  privateReportResponse,
} from "../../../../server/report-export.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) =>
  dashboardRequest(request, async (_: unknown, uid: string) =>
    privateReportResponse(
      request,
      await privateReportService(getDatabase()).create(uid),
    ),
  );
