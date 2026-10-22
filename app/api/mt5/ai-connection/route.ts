import { dashboardRequest, jsonInput } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { ApiError } from "../../../../server/errors.mjs";
import { aiConnectionService } from "../../../../server/ai-connection.mjs";
import { openaiCredentialService } from "../../../../server/openai-credentials.mjs";
import { usageService } from "../../../../server/ai-usage.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) =>
    aiConnectionService(getDatabase(), {
      resolveEnvironment: (id: string) =>
        openaiCredentialService(getDatabase()).environment(id),
    }).status(uid),
  );

export const POST = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) => {
    const body = await jsonInput(req, 128);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length
    )
      throw new ApiError(
        400,
        "The connection test accepts an empty JSON object only.",
        "AI_TEST_INVALID_INPUT",
      );
    const db = getDatabase();
    return aiConnectionService(db, {
      resolveEnvironment: (id: string) =>
        openaiCredentialService(db).environment(id),
      responder: usageService(db).responder(uid, "connection-test"),
    }).test(uid);
  });
