import {
  billingService,
  readBillingWebhook,
} from "../../../../server/billing.mjs";
import { getDatabase } from "../../../../server/database.mjs";
import { handle } from "../../../../server/http.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = (req: Request) =>
  handle(async () =>
    billingService(getDatabase()).webhook(
      await readBillingWebhook(req),
      req.headers,
    ),
  );
