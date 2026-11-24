/**
 * Hand a verified private response to the browser's normal download mechanism.
 * A click requests a download; it cannot prove that a user saved the file.
 * @param {Response} response
 * @param {{filename: string, contentTypes: string[], validate?: (blob: Blob) => Promise<void>}} options
 */
export async function requestBrowserDownload(
  response,
  { filename, contentTypes, validate },
) {
  const contentType = response.headers
    .get("Content-Type")
    ?.split(";")[0]
    .trim();
  if (!response.ok || !contentType || !contentTypes.includes(contentType))
    throw new Error(
      "The server did not return the expected download file. Refresh the connection and try again.",
    );
  const blob = await response.blob();
  if (!blob.size)
    throw new Error(
      "The server returned an empty download. Try again after checking the connection.",
    );
  if (validate) await validate(blob);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  let requested = false;
  try {
    anchor.href = url;
    anchor.download = filename.replace(/[\\/\u0000-\u001f\u007f]/g, "_");
    document.body.appendChild(anchor);
    anchor.click();
    requested = true;
  } finally {
    anchor.remove();
    if (requested) window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    else URL.revokeObjectURL(url);
  }
}

/** @param {Response} response
 * @param {{connectionId: string, installationId: string | null, replacing: boolean, format: "package" | "source", engineVersion: string}} expected
 */
export async function requestEaDownload(response, expected) {
  const installation = response.headers.get("X-Rocket-Installation") || "";
  const digest = response.headers.get("X-Rocket-SHA256") || "";
  if (
    response.headers.get("X-Rocket-Connection") !== expected.connectionId ||
    response.headers.get("X-Rocket-Protocol") !== "4" ||
    response.headers.get("X-Rocket-Engine") !== expected.engineVersion ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      installation,
    ) ||
    (expected.installationId &&
      (installation === expected.installationId) === expected.replacing) ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw Error(
      "The EA file could not be verified for the selected installation.",
    );
  const source = expected.format === "source";
  if (
    !source &&
    !/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(
      response.headers.get("X-Rocket-OpenAI-Model") || "",
    )
  )
    throw new Error(
      "The server did not confirm a verified OpenAI model for this EA download.",
    );
  await requestBrowserDownload(response, {
    filename: `ROCKET1000_EA.${source ? "mq5" : "zip"}`,
    contentTypes: [source ? "text/x-mql5" : "application/zip"],
    async validate(blob) {
      if (blob.size > 5000000)
        throw Error("The EA download exceeds the expected size.");
      const bytes = await blob.arrayBuffer();
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const head = new TextDecoder().decode(bytes.slice(0, 80));
      if (
        hash !== digest ||
        (source
          ? !head.startsWith("// ROCKET1000 EA")
          : !head.startsWith("PK\u0003\u0004"))
      )
        throw Error("The EA download failed its integrity check.");
    },
  });
  return installation;
}
