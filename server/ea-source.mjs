import { ApiError } from "./errors.mjs";

const start = "// ROCKET1000_CONFIG_BEGIN";
const end = "// ROCKET1000_CONFIG_END";

// This private source is issued only after the same ownership/HTTPS checks as an EA package.
// Replace the entire file loader so the downloaded EA has no external config dependency.
export function personalizedEaSource({
  source,
  serverUrl,
  installationId,
  credential,
  expiresAt,
}) {
  const template = source?.toString("utf8");
  if (
    !template ||
    template.split(start).length !== 2 ||
    template.split(end).length !== 2 ||
    !/^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+$/.test(serverUrl) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      installationId,
    ) ||
    !new RegExp(`^r1000\\.${installationId}\\.[A-Za-z0-9_-]{43}$`).test(
      credential,
    ) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  )
    throw new ApiError(
      503,
      "The personalized EA source could not be prepared.",
    );
  const from = template.indexOf(start),
    to = template.indexOf(end);
  if (to < from) throw new ApiError(503, "The EA source template is invalid.");
  const loader = `bool LoadConfig() {
   const string url=${JSON.stringify(serverUrl)};
   const string token=${JSON.stringify(credential)};
   const string id=${JSON.stringify(installationId)};
   if(!SafeOrigin(url) || !SafeCredential(token) || StringLen(id)!=36 || StringFind(token,"r1000."+id+".")!=0) return false;
   if(token!=credential || url!=backend_url) registered=false;
   backend_url=url;credential=token;installation_id=id;
   return true;
}`;
  const header = `// ROCKET1000 EA - your private, preconfigured connection.
// Open in MetaEditor. Save As MQL5/Experts/ROCKET1000_EA.mq5, then Compile (F7).
// Allow WebRequest for ${serverUrl}, then attach the compiled EA to one demo or live account chart.
// Keep this file private. A replacement download revokes this installation.
// Connection credential expires: ${new Date(expiresAt).toISOString()}
// No separate config file or manual token entry. Orders are disabled by default.
// Start automatic or reviewed orders explicitly in Account & settings after the risk checks pass.
`;
  const rendered =
    header + template.slice(0, from) + loader + template.slice(to + end.length);
  if (/FileOpen\s*\(|rocket1000\.config/.test(rendered))
    throw new ApiError(
      503,
      "The personalized EA still requires an external file.",
    );
  return rendered;
}
