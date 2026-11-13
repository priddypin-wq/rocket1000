import { handleCallback } from "@vercel/queue";
import { getDatabase } from "../../../../server/database.mjs";
import { analysisQueue } from "../../../../server/analysis-queue.mjs";

export const runtime = "nodejs";
export const maxDuration = 60;
// Vercel registers this as a private queue consumer, not a browser command API.
export const POST = handleCallback(
  async (message) => {
    await analysisQueue(getDatabase()).consume(message);
  },
  {
    retry: (_error, metadata) =>
      metadata.deliveryCount > 5 ? { acknowledge: true } : { afterSeconds: 30 },
  },
);
