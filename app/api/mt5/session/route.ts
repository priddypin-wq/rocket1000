import { initializeBrowser } from "../../../../server/http.mjs";
export const runtime = "nodejs";
export const POST = (req: Request) => initializeBrowser(req);
