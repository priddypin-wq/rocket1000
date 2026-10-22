import { getDatabase } from "../../../server/database.mjs";
import { handle } from "../../../server/http.mjs";
import { health } from "../../../server/deployment.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = () => handle(() => health(getDatabase()));
