import { dashboardRequest } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import {
  backendOrigin,
  compiledArtifact,
  ApiError,
} from "../../../../server/provisioning.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: Request) =>
  dashboardRequest(
    req,
    async (
      service: ReturnType<
        typeof import("../../../../server/provisioning.mjs").provisioningService
      >,
      uid: string,
    ) => {
      const { id } = await service.create(uid);
      let downloadReady = false;
      let provisioningError = "";
      let serverUrl: string | null = null;
      let verifiedAt: number | null = null;
      try {
        const configured = backendOrigin();
        await compiledArtifact();
        const [generated] = await getDatabase().query(
          "SELECT * FROM rocket_generated_connections WHERE connection_id=?",
          [id],
        );
        if (generated?.server_url === configured) {
          serverUrl = configured;
          verifiedAt = Number(generated.verified_at);
          downloadReady = true;
        } else
          provisioningError =
            "Generate Connection to verify the live HTTPS server.";
      } catch (e) {
        provisioningError =
          e instanceof ApiError
            ? e.message
            : "Server configuration is incomplete.";
      }
      return {
        connections: await service.list(uid),
        serverUrl,
        downloadReady,
        provisioningError,
        verifiedAt,
      };
    },
  );
