/**
 * Hand a verified private response to the browser's normal download mechanism.
 * A click requests a download; it cannot prove that a user saved the file.
 * @param {Response} response
 * @param {{filename: string, contentTypes: string[]}} options
 */
export async function requestBrowserDownload(
  response,
  { filename, contentTypes },
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
