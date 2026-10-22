import { dashboardRequest, jsonInput } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { ApiError } from "../../../../server/errors.mjs";
import { usageService } from "../../../../server/ai-usage.mjs";
import { credentialChanged } from "../../../../server/engine-service.mjs";
import {
  openaiCredentialService,
  assertOpenaiHttps,
} from "../../../../server/openai-credentials.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    openaiCredentialService(getDatabase()).status(uid),
  );

export const POST = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) => {
    assertOpenaiHttps(req);
    const body = await jsonInput(req, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ApiError(
        400,
        "Choose Save, Test or Remove.",
        "OPENAI_ACTION_INVALID",
      );
    const db = getDatabase();
    const service = openaiCredentialService(db, {
      onChange: credentialChanged,
      responder: usageService(db).responder(uid, "connection-test"),
    });
    if (
      body.action === "save" &&
      Object.keys(body).every((k) => ["action", "key", "model"].includes(k))
    )
      return service.save(uid, {
        key: body.key,
        ...(body.model === undefined ? {} : { model: body.model }),
      });
    if (Object.keys(body).length === 1 && body.action === "test") {
      await service.test(uid);
      return service.status(uid);
    }
    if (Object.keys(body).length === 1 && body.action === "remove")
      return service.remove(uid);
    throw new ApiError(
      400,
      "Choose Save, Test or Remove.",
      "OPENAI_ACTION_INVALID",
    );
  });
