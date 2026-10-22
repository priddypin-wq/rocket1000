import { dashboardRequest, jsonInput } from "../../../../server/http.mjs";
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
      const { connectionId } = await jsonInput(req);
      await service.revoke(uid, connectionId);
      return { ok: true };
    },
  );
