const states = new Set([
  "stopped",
  "verifying",
  "scheduled",
  "running",
  "suspended",
]);

export function engineIdentityMatches(engine, orders) {
  return !!(
    engine?.accountKey &&
    engine.accountKey === orders?.accountKey &&
    engine.installationId &&
    engine.installationId === orders.connection?.installationId &&
    engine.sessionId &&
    engine.sessionId === orders.connection?.sessionId
  );
}

/**
 * One browser-wide control lane. Stop requests supersede verification instead
 * of waiting for a model request, and superseded responses cannot restore ON.
 * @param {{request: (path: string, body?: unknown) => Promise<Response>, onStopped?: () => void}} options
 */
export function createEngineControls({ request, onStopped = () => {} }) {
  const initial = Object.freeze({
    data: null,
    error: "",
    busy: false,
    pendingAction: "",
    revision: 0,
  });
  /** @type {{data: any, error: string, busy: boolean, pendingAction: string, revision: number}} */
  let state = initial;
  const listeners = new Set();
  let revision = 0;
  /** @type {{key: string, action: string, promise: Promise<boolean>} | null} */
  let operation = null;
  /** @type {Promise<boolean> | null} */
  let polling = null;
  function publish(patch) {
    state = Object.freeze({ ...state, ...patch, revision });
    for (const listener of listeners) listener();
  }
  function validateStatus(data) {
    if (!data || !states.has(data.state))
      throw Error("Engine status was not confirmed by the server.");
    return data;
  }
  function refresh() {
    if (operation) return Promise.resolve(false);
    if (polling) return polling;
    const generation = revision;
    polling = Promise.resolve().then(async () => {
      try {
        const data = validateStatus(await (await request("engine")).json());
        if (generation !== revision) return false;
        publish({ data, error: "" });
        return true;
      } catch (error) {
        if (generation === revision)
          publish({
            error:
              error instanceof Error
                ? error.message
                : "Engine status unavailable",
          });
        return false;
      } finally {
        polling = null;
      }
    });
    return polling;
  }
  function execute(body, emergency = false) {
    const action = emergency ? "emergency-stop" : String(body.action || "");
    const stopping = action === "stop" || emergency;
    const key = JSON.stringify({ action, body });
    if (operation) {
      if (
        operation.key === key ||
        (stopping && operation.action === "emergency-stop")
      )
        return operation.promise;
      if (!stopping) return Promise.resolve(false);
    }
    const generation = ++revision;
    publish({
      busy: true,
      pendingAction: action,
      error: "",
      ...(stopping ? { data: null } : {}),
    });
    const promise = Promise.resolve().then(async () => {
      if (generation !== revision) return false;
      try {
        const result = await (
          await request(emergency ? "stop" : "engine", emergency ? {} : body)
        ).json();
        if (emergency) {
          if (result?.ok !== true || result.tradingEnabled !== false)
            throw Error(
              "Emergency Stop was not confirmed. Check the MT5 terminal.",
            );
        } else {
          validateStatus(result);
          if (
            stopping &&
            (result.state !== "stopped" || result.executionAuthorized === true)
          )
            throw Error(
              "The server has not confirmed that the engine stopped.",
            );
        }
        if (generation !== revision) return false;
        publish({
          data: emergency ? null : result,
          busy: false,
          pendingAction: "",
          error: "",
        });
        if (stopping) {
          onStopped();
          if (emergency) queueMicrotask(() => void refresh());
        }
        return true;
      } catch (error) {
        if (generation === revision)
          publish({
            busy: false,
            pendingAction: "",
            error:
              error instanceof Error
                ? error.message
                : "Engine action was not confirmed",
          });
        return false;
      } finally {
        if (generation === revision) operation = null;
      }
    });
    operation = { key, action, promise };
    return promise;
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    action: (body) => execute(body),
    emergencyStop: () => execute({}, true),
  };
}
