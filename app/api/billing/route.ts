import {
  assertBillingAccount,
  billingService,
} from "../../../server/billing.mjs";
import { getDatabase } from "../../../server/database.mjs";
import { ApiError } from "../../../server/errors.mjs";
import { dashboardRequest, jsonInput } from "../../../server/http.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) =>
  dashboardRequest(req, async (_service, workspaceId, session) => {
    const owner = assertBillingAccount(session, workspaceId);
    return billingService(getDatabase()).status(owner);
  });

export const POST = (req: Request) =>
  dashboardRequest(req, async (provisioning, workspaceId, session) => {
    const owner = assertBillingAccount(session, workspaceId);
    if (new URL(req.url).protocol !== "https:")
      throw new ApiError(
        403,
        "Billing requests require HTTPS.",
        "BILLING_HTTPS_REQUIRED",
      );
    const body = await jsonInput(req, 1024);
    const billing = billingService(getDatabase());
    await provisioning.rateLimit("billing:" + workspaceId, 12);
    if (body?.action === "checkout" && Object.keys(body).length === 3)
      return billing.checkout(owner, {
        planId: body.planId,
        email: body.email,
      });
    if (body?.action === "verify" && Object.keys(body).length === 2)
      return billing.verify(owner, body.reference);
    if (body?.action === "cancel" && Object.keys(body).length === 1)
      return billing.cancel(owner);
    throw new ApiError(
      400,
      "Choose a valid billing action.",
      "BILLING_ACTION_INVALID",
    );
  });
