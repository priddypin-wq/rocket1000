import { accountRequest } from "../account-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => accountRequest(req, "session");
