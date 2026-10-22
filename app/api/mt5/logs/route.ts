import { dashboardRequest } from "../../../../server/http.mjs";
export const runtime = "nodejs";
export const GET = (req: Request) =>
  dashboardRequest(
    req,
    async (
      service: ReturnType<
        typeof import("../../../../server/provisioning.mjs").provisioningService
      >,
      uid: string,
    ) => ({
      logs: await service.logs(uid),
    }),
  );
