import { dashboardRequest } from "../../../../server/http.mjs";
export const runtime = "nodejs";
export const POST = (req: Request) =>
  dashboardRequest(
    req,
    async (
      service: ReturnType<
        typeof import("../../../../server/provisioning.mjs").provisioningService
      >,
      uid: string,
    ) => {
      await service.create(uid);
      await service.stop(uid);
      return { ok: true, tradingEnabled: false };
    },
  );
