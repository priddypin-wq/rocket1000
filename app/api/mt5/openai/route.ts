import { dashboardRequest, jsonInput } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { ApiError } from "../../../../server/errors.mjs";
import {
  usageService,
  selectableModels,
} from "../../../../server/ai-usage.mjs";
import { credentialChanged } from "../../../../server/engine-service.mjs";
import {
  openaiCredentialService,
  assertOpenaiHttps,
  openaiServerManaged,
  assertOpenaiCredentialWritable,
} from "../../../../server/openai-credentials.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) => {
    const metadata = await openaiCredentialService(getDatabase()).status(uid);
    return {
      ...metadata,
      models: metadata.serverManaged ? [] : selectableModels,
    };
  });

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
    // In the default mode, even a test carrying an extra key/model is rejected.
    // Only a fixed diagnostic request may cross the browser/server boundary.
    if (
      openaiServerManaged(process.env, uid) &&
      (body.action !== "test" || Object.keys(body).length !== 1)
    )
      assertOpenaiCredentialWritable(process.env, uid);
    const db = getDatabase();
    const service = openaiCredentialService(db, {
      onChange: credentialChanged,
      responder: usageService(db).responder(uid, "connection-test"),
    });
    if (
      body.action === "save" &&
      Object.keys(body).every((k) =>
        ["action", "key", "model", "revision"].includes(k),
      )
    )
      return service.save(uid, {
        key: body.key,
        ...(body.revision === undefined ? {} : { revision: body.revision }),
        ...(body.model === undefined ? {} : { model: body.model }),
      });
    if (
      body.action === "test" &&
      Object.keys(body).every((k) => ["action", "revision"].includes(k)) &&
      (body.revision === undefined ||
        (typeof body.revision === "string" && body.revision.length === 36))
    ) {
      await service.test(uid, body.revision);
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
