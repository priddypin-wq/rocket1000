import { dashboardRequest } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { assertRequestedAccount } from "../../../../server/requested-account.mjs";
import {
  privateReportService,
  privateReportResponse,
} from "../../../../server/report-export.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) =>
  dashboardRequest(request, async (_: unknown, uid: string) => {
    const report = await privateReportService(getDatabase()).create(uid);
    const expectedAccountKey = new URL(request.url).searchParams.get(
      "expectedAccountKey",
    );
    if (expectedAccountKey !== null)
      assertRequestedAccount(report, { expectedAccountKey });
    return privateReportResponse(request, report);
  });
