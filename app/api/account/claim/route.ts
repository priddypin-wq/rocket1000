import { accountRequest } from "../account-request";

export const runtime = "nodejs";
export const POST = (req: Request) => accountRequest(req, "claim");
