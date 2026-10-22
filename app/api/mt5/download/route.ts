import {
  dashboardRequest,
  jsonInput,
  responseHeaders,
} from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { ApiError, backendOrigin } from "../../../../server/provisioning.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) =>
  dashboardRequest(
    req,
    async (
      service: ReturnType<
        typeof import("../../../../server/provisioning.mjs").provisioningService
      >,
      uid: string,
    ) => {
      const { connectionId, format = "source" } = await jsonInput(req);
      await service.rateLimit(`download:${uid}`, 5);
      if (
        typeof connectionId !== "string" ||
        !(await service.list(uid)).some(
          (c: { id: string }) => c.id === connectionId,
        )
      )
        throw new ApiError(404, "Connection not found");
      const [verified] = await getDatabase().query(
        "SELECT g.server_url FROM rocket_generated_connections g JOIN rocket_direct_connections c ON c.id=g.connection_id WHERE c.id=? AND c.user_id=?",
        [connectionId, uid],
      );
      if (!verified)
        throw new ApiError(
          409,
          "Generate and verify this connection before downloading the EA.",
          "CONNECTION_NOT_GENERATED",
        );
      if (verified.server_url !== backendOrigin())
        throw new ApiError(
          409,
          "The server address changed. Generate the connection again.",
          "CONNECTION_NOT_GENERATED",
        );
      const bytes = await service.download(uid, connectionId, { format });
      return new Response(new Uint8Array(bytes), {
        headers: {
          ...responseHeaders,
          "Content-Type":
            format === "source"
              ? "text/x-mql5; charset=utf-8"
              : "application/zip",
          "Content-Disposition": `attachment; filename="ROCKET1000_EA.${format === "source" ? "mq5" : "zip"}"`,
        },
      });
    },
  );
