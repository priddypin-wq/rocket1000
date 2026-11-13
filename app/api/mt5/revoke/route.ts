import { dashboardRequest, jsonInput } from "../../../../server/http.mjs";
import { ApiError } from "../../../../server/errors.mjs";
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
      const input = await jsonInput(req);
      if (typeof input?.expectedInstallationId !== "string")
        throw new ApiError(
          400,
          "Review the current installation before revoking access.",
        );
      return service.revoke(
        uid,
        input.connectionId,
        input.expectedInstallationId,
      );
    },
  );
