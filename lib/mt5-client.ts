let initialization: Promise<void> | null = null;
export async function privateBrowserSession() {
  if (!initialization) {
    initialization = fetch("/api/mt5/session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(
            data.error || "Could not initialize the private connection.",
          );
        }
      })
      .catch((error) => {
        initialization = null;
        throw error;
      });
  }
  return initialization;
}
export async function mt5Api(path: string, body?: unknown) {
  await privateBrowserSession();
  const response = await fetch(`/api/mt5/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) initialization = null;
    throw new Error(data.error || "Unable to reach the connection server.");
  }
  return response;
}
