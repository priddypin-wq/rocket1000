import {
  accountSessions,
  assertAccountOrigin,
} from "../../../server/account-auth.mjs";
import { getDatabase } from "../../../server/database.mjs";
import { ApiError } from "../../../server/errors.mjs";
import { handle, jsonInput, responseHeaders } from "../../../server/http.mjs";
import { provisioningService } from "../../../server/provisioning.mjs";

type PasskeyPurpose = "register" | "login" | "passkeys";
type AccountAction = PasskeyPurpose | "session" | "logout" | "claim";

export function accountRequest(req: Request, action: AccountAction) {
  return handle(async () => {
    assertAccountOrigin(req);
    const db = getDatabase();
    const accounts = accountSessions(db);
    const service = provisioningService(db);
    let result;
    if (action === "session") {
      result = await accounts.status(req);
    } else if (action === "logout") {
      result = await accounts.logout(req);
    } else {
      await service.rateLimit(`account:${action}`, 120);
      const input = await jsonInput(req, 65_536);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new ApiError(400, "Invalid account request.");
      if (action === "claim") {
        result =
          input.skip === true
            ? await accounts.skipClaim(req)
            : await accounts.claim(req, input.confirm);
      } else if (input.action === "options") {
        result = await accounts.options(req, action, input);
      } else if (input.action === "verify") {
        result = await accounts.verify(req, action, input.response);
      } else {
        throw new ApiError(400, "Invalid passkey action.");
      }
    }
    const headers = new Headers(responseHeaders);
    for (const cookie of result.cookies) headers.append("Set-Cookie", cookie);
    return Response.json(result.body, { headers });
  });
}
