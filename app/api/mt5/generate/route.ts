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
      await db.query(
        "INSERT INTO rocket_generated_connections(connection_id,server_url,verified_at) VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET server_url=excluded.server_url,verified_at=excluded.verified_at",
        [id, serverUrl, Date.now()],
      );
      return { connectionId: id, serverUrl, verifiedAt: Date.now() };
    },
  );
