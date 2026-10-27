import { dashboardRequest, jsonInput } from "../../../../server/http.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { engineService } from "../../../../server/engine-service.mjs";
import { ApiError } from "../../../../server/errors.mjs";
import { analysisQueue } from "../../../../server/analysis-queue.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) => {
    const db = getDatabase();
    await analysisQueue(db).probe(uid);
    return engineService(db).status(uid);
  });
export const POST = (req: Request) =>
  dashboardRequest(req, async (_: unknown, uid: string) => {
    const input = await jsonInput(req, 2048),
      engine = engineService(getDatabase());
    if (input?.action === "start" && Object.keys(input).length === 1)
      return analysisQueue(getDatabase()).start(uid);
    if (input?.action === "start-analysis" && Object.keys(input).length === 1)
      return analysisQueue(getDatabase()).start(uid, { analysisOnly: true });
    if (input?.action === "stop" && Object.keys(input).length === 1)
      return engine.stop(uid);
    if (
      input?.action === "configure" &&
      Object.keys(input).every((k) =>
        ["action", "frequencySeconds", "dailyBudgetUsd"].includes(k),
      )
    )
      return engine.configure(uid, input);
    throw new ApiError(
      400,
      "Choose Start, Stop or valid analysis cost settings.",
    );
  });
