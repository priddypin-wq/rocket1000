import {
  browserSessionStatus,
  initializeBrowser,
} from "../../../../server/http.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => browserSessionStatus(req);
export const POST = (req: Request) => initializeBrowser(req);
