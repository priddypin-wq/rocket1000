import { dashboardRequest } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { verifyDeployment } from "../../../../server/deployment.mjs";
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
      const db = getDatabase();
      await service.rateLimit(`generate:${uid}`, 5);
      const serverUrl = await verifyDeployment(db);
      const { id } = await service.create(uid);
      const verifiedAt = Date.now();
      await db.query(
        "INSERT INTO rocket_generated_connections(connection_id,server_url,verified_at) VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET server_url=excluded.server_url,verified_at=excluded.verified_at",
        [id, serverUrl, verifiedAt],
      );
      const [installation] = await db.query(
        "SELECT id FROM rocket_direct_installations WHERE connection_id=? ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 1",
        [id],
      );
      return {
        connectionId: id,
        installationId: installation?.id ?? null,
        serverUrl,
        verifiedAt,
      };
    },
  );
