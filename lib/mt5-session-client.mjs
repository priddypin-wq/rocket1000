const SESSION_LOCK = "rocket1000-private-browser-session";

/**
 * Browser credentials stay in the shared HttpOnly cookie. The lock only
 * serializes first-time initialization; no credential or account is copied
 * into JavaScript storage or passed between tabs.
 * @param {{fetch?: typeof fetch, lockManager?: () => Pick<LockManager, "request"> | null | undefined}} options
 */
export function createMt5Client({
  fetch: request = (...args) => globalThis.fetch(...args),
  lockManager = () => globalThis.navigator?.locks,
} = {}) {
  /** @type {Promise<void> | null} */
  let initialization = null;
  let sessionLost = false;

  /** @param {boolean} readOnly */
  async function initialize(readOnly) {
    const response = await request("/api/mt5/session", {
      method: readOnly ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message =
        readOnly && response.status === 401
          ? sessionLost
            ? "This browser's private connection is unavailable. Reopen the original connected browser before continuing."
            : "Open ROCKET1000 in an updated browser to initialize its private connection safely."
          : data.error || "Could not initialize the private connection.";
      throw Object.assign(new Error(message), {
        code: typeof data.code === "string" ? data.code : "REQUEST_FAILED",
        status: response.status,
      });
    }
  }

  async function privateBrowserSession() {
    if (!initialization) {
      const locks = lockManager();
      initialization = Promise.resolve()
        .then(() => {
          // The second tab sends POST only after the first tab's Set-Cookie
          // has completed, so the server reuses the very same workspace.
          if (locks?.request)
            return locks.request(SESSION_LOCK, { mode: "exclusive" }, () =>
              initialize(sessionLost),
            );
          // Legacy browsers may reuse an existing session, but must not race
          // to create different connections without a cross-tab lock.
          return initialize(true);
        })
        .catch((error) => {
          initialization = null;
          throw error;
        });
    }
    return initialization;
  }

  /**
   * @param {string} path
   * @param {unknown} [body]
   */
  async function mt5Api(path, body) {
    await privateBrowserSession();
    const response = await request(`/api/mt5/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && data.code === "BROWSER_SESSION_REQUIRED") {
        initialization = null;
        sessionLost = true;
      }
      // Never replay an action after an authentication failure. In particular,
      // a later action cannot silently create a replacement empty workspace.
      throw Object.assign(
        new Error(data.error || "Unable to reach the connection server."),
        {
          code: typeof data.code === "string" ? data.code : "REQUEST_FAILED",
          status: response.status,
        },
      );
    }
    return response;
  }
  return { privateBrowserSession, mt5Api };
}
