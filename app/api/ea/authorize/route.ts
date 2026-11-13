import { eaRequest } from "../../../../server/http.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => eaRequest(req, false, { authorize: true });
