"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { mt5Api } from "../../lib/mt5-client";
import { confirmedOpenAiAction } from "../../lib/action-confirmation.mjs";

type Metadata = {
  serverManaged?: boolean;
  workspaceRef?: string;
  disabledByRemoval?: boolean;
  configured: boolean;
  state?: string;
  error?: string | null;
  model?: string | null;
  storageReady?: boolean;
  encryptionReady?: boolean;
  stored?: boolean;
  source?: string;
  revision?: string | null;
  models?: string[];
  connection?: {
    state?: string;
    checkedAt?: number | null;
    expiresAt?: number;
    connected?: boolean;
    error?: string | null;
    errorCode?: string | null;
  };
};

async function openAiRequest(
  body?: Record<string, unknown>,
): Promise<Metadata> {
  const timeout = body?.action === "test" ? 60000 : 15000;
  return (
    await mt5Api("openai", body, { signal: AbortSignal.timeout(timeout) })
  ).json();
}

function modelLabel(id: string) {
  return id
    .replace(/^gpt-/i, "GPT-")
    .replace(
      /-(astra|sol|mini)$/,
      (_, name: string) => " " + name[0].toUpperCase() + name.slice(1),
    );
}

export default function OpenAiConnection() {
  const [status, setStatus] = useState<Metadata | null>(null);
  const [busy, setBusy] = useState("");
  const [issue, setIssue] = useState("");
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const [models, setModels] = useState<string[]>([]);
  const [choice, setChoice] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [needsAccount, setNeedsAccount] = useState(false);
  const [reload, setReload] = useState(0);
  const model =
    choice === "custom" ? customModel.trim() : choice || status?.model || "";
  const mounted = useRef(false);
  const generation = useRef(0);
  const actionInFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const current = ++generation.current;
    void openAiRequest()
      .then((metadata) => {
        if (mounted.current && current === generation.current) {
          setStatus(metadata);
          setModels(metadata.models || []);
          setIssue("");
          setNeedsAccount(false);
        }
      })
      .catch((e) => {
        if (mounted.current && current === generation.current) {
          setNeedsAccount(
            ["ACCOUNT_SESSION_REQUIRED", "LEGACY_CLAIM_PENDING"].includes(
              e?.code,
            ),
          );
          setIssue(
            e instanceof Error ? e.message : "OpenAI connection unavailable",
          );
        }
      });
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [reload]);
  const expiresAt = status?.connection?.expiresAt;
  useEffect(() => {
    if (!expiresAt || !status?.connection?.connected) return;
    const timeout = window.setTimeout(
      () => {
        setStatus((previous) =>
          previous?.connection?.expiresAt === expiresAt
            ? {
                ...previous,
                connection: { ...previous.connection, connected: false },
              }
            : previous,
        );
        setNotice("");
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [expiresAt, status?.connection?.connected]);

  async function perform(action: "save" | "test" | "remove") {
    if (actionInFlight.current) return;
    setIssue("");
    setNotice("");
    if (action !== "test" && status?.serverManaged !== false) {
      setIssue("The server operator manages the OpenAI connection.");
      return;
    }
    if (action === "test" && !status?.configured) {
      setIssue("Configure and save the OpenAI connection before testing it.");
      return;
    }
    if (
      action === "save" &&
      (status?.encryptionReady ?? status?.storageReady) === false
    ) {
      setIssue(
        "Secure server encryption must be configured before saving an API key.",
      );
      return;
    }
    if (action === "remove" && !status?.configured) {
      setIssue("There is no saved OpenAI connection to remove.");
      return;
    }
    const key = action === "save" ? keyInput.current?.value.trim() : undefined;
    if (action === "save" && (!model || (!key && !status?.stored))) {
      setIssue(
        !model
          ? "Choose an OpenAI model first."
          : "Enter your OpenAI API key first.",
      );
      return;
    }
    if (location.protocol !== "https:") {
      setIssue(
        "Open the HTTPS version of ROCKET1000 to save or test your key.",
      );
      return;
    }
    if (keyInput.current) keyInput.current.value = "";
    setEditingKey(false);
    actionInFlight.current = true;
    setBusy(action);
    const current = ++generation.current;
    try {
      let expected = status;
      if (action === "save" && (key || model !== status?.model)) {
        expected = await openAiRequest({
          action: "save",
          model,
          ...(key ? { key } : { revision: status?.revision }),
        });
        confirmedOpenAiAction(expected, "save");
        if (!mounted.current || current !== generation.current) return;
        if (expected.model !== model)
          throw Error("The saved model changed. Review it before testing.");
        setStatus(expected);
        setNotice("Saved. Waiting for OpenAI to verify the connection.");
      }
      if (action !== "remove") setBusy("test");
      const metadata = await openAiRequest({
        action: action === "remove" ? "remove" : "test",
        ...(action !== "remove" && expected?.revision
          ? { revision: expected.revision }
          : {}),
      });
      if (!mounted.current || current !== generation.current) return;
      confirmedOpenAiAction(metadata, action === "remove" ? "remove" : "test");
      setStatus(metadata);
      setRemoving(false);
      if (
        action !== "remove" &&
        (metadata.model !== expected?.model ||
          metadata.revision !== expected?.revision)
      )
        throw Error(
          "The OpenAI settings changed during the test. Review the model and test again.",
        );
      setChoice("");
      setNotice(
        action === "remove"
          ? "API key removed. AI analysis and new automated orders are stopped."
          : metadata.connection?.connected === true
            ? "OpenAI connection verified. No trades were submitted."
            : "",
      );
    } catch (e) {
      if (mounted.current && current === generation.current) {
        // Only the backend's sanitized message is displayed. Never reflect the submitted key.
        setNotice("");
        if (
          e instanceof Error &&
          "code" in e &&
          (e.code === "ACCOUNT_SESSION_REQUIRED" ||
            e.code === "LEGACY_CLAIM_PENDING")
        ) {
          setStatus(null);
          setNeedsAccount(true);
        }
        const message =
          e instanceof Error ? e.message : "OpenAI request failed";
        setIssue(
          key && message.includes(key)
            ? "OpenAI request failed. Check the server connection."
            : message,
        );
      }
      try {
        const metadata = await openAiRequest();
        if (mounted.current && current === generation.current)
          setStatus(metadata);
      } catch {
        /* Keep the last confirmed metadata. */
      }
    } finally {
      actionInFlight.current = false;
      if (mounted.current && current === generation.current) setBusy("");
    }
  }
  const verified =
    !issue &&
    !busy &&
    !editingKey &&
    model === status?.model &&
    status?.connection?.connected === true;
  const storageReady = status?.encryptionReady ?? status?.storageReady;
  // Missing/loading metadata stays in the default environment-only mode.
  const serverManaged = status?.serverManaged !== false;
  return (
    <section
      className="inner-card openai-connection"
      id="ai-connection"
      aria-labelledby="openai-title"
    >
      <div className="inner-card-title">
        <span id="openai-title">Connect AI</span>
        <span
          className={`settings-status ${verified ? "is-connected" : ""}`}
          role="status"
        >
          {!status
            ? issue
              ? "Unavailable"
              : "Checking…"
            : busy === "test"
              ? "Testing…"
              : verified
                ? "Connected"
                : status.configured
                  ? "Needs verification"
                  : "Not configured"}
        </span>
      </div>
      {!status ? (
        <div>
          {needsAccount ? (
            <Link href="/account" className="inner-text-link">
              Sign in to ROCKET1000
            </Link>
          ) : issue ? (
            <button
              className="action-outline"
              onClick={() => setReload(reload + 1)}
            >
              Retry connection settings
            </button>
          ) : null}
        </div>
      ) : serverManaged ? (
        <div>
          <p className="inner-caption">
            Server managed. To use your own key, enable personal-key access for
            this workspace on the server.
          </p>
          {status.workspaceRef && (
            <details className="settings-inline-details">
              <summary>Enable my API key</summary>
              <p>
                For local SQLite, run <code>npm run setup:openai</code> in the
                app folder. On a shared server, set{" "}
                <code>ROCKET_OPENAI_PERSONAL_WORKSPACE</code> to{" "}
                <code>{status.workspaceRef}</code> on the app and worker.
              </p>
            </details>
          )}
          <p>
            Configuration:{" "}
            {status
              ? status.configured
                ? "Configured"
                : "Unavailable"
              : "Checking…"}
            <br />
            Model: <strong>{status?.model || "Checking…"}</strong>
          </p>
          {status?.disabledByRemoval ? (
            <p className="inner-error" role="alert">
              AI requests remain disabled following a previous credential
              removal. The server operator must review this workspace before
              reconnecting.
            </p>
          ) : status && !status.configured ? (
            <p className="inner-error" role="alert">
              The server operator must configure the OpenAI connection before AI
              analysis can start.
            </p>
          ) : null}
          <div className="engine-actions">
            <button
              className="action-outline"
              type="button"
              disabled={!!busy || !status?.configured}
              onClick={() => void perform("test")}
            >
              {busy === "test" ? "Testing…" : "Test Connection"}
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform("save");
          }}
        >
          <label className="trade-field">
            Model
            <span className="openai-model-picker">
              <span aria-hidden="true">ϟ</span>
              <select
                name="model"
                value={choice || status.model || ""}
                disabled={!!busy}
                onChange={(event) => {
                  setChoice(event.target.value);
                  setNotice("");
                }}
              >
                {!status.model && <option value="">Choose a model</option>}
                {Array.from(
                  new Set([...(status.model ? [status.model] : []), ...models]),
                ).map((id) => (
                  <option key={id} value={id}>
                    {modelLabel(id)}
                  </option>
                ))}
                <option value="custom">Enter another model ID…</option>
              </select>
              <span aria-hidden="true">›</span>
            </span>
          </label>
          {choice === "custom" && (
            <label className="trade-field">
              OpenAI model ID
              <input
                name="custom-model"
                value={customModel}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setCustomModel(event.target.value)}
                maxLength={100}
                disabled={!!busy}
                required
              />
            </label>
          )}
          <label className="trade-field">
            OpenAI API key
            <input
              ref={keyInput}
              onChange={(event) => {
                setEditingKey(!!event.target.value);
                setNotice("");
              }}
              type="password"
              name="openai-api-key"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={
                status.stored
                  ? "Leave blank to use your saved key"
                  : "Paste your OpenAI API key"
              }
              disabled={!!busy}
              required={!status.stored}
              data-1p-ignore="true"
              data-lpignore="true"
            />
          </label>
          <div className="engine-actions">
            <button
              className="action-red"
              type="submit"
              disabled={!!busy || storageReady === false}
            >
              {busy === "save"
                ? "Saving…"
                : busy === "test"
                  ? "Testing…"
                  : "Save & Test Connection"}
            </button>
          </div>
        </form>
      )}
      {!serverManaged && status?.configured ? (
        <button
          className="inner-text-button"
          type="button"
          disabled={!!busy}
          onClick={() => setRemoving(true)}
        >
          Remove API Key
        </button>
      ) : null}
      {!serverManaged && removing ? (
        <div className="trade-review">
          <p>
            Remove this app’s saved OpenAI key and stop further AI requests?
            Existing positions remain open.
          </p>
          <div className="engine-actions">
            <button
              className="action-outline"
              disabled={!!busy}
              onClick={() => setRemoving(false)}
            >
              Cancel
            </button>
            <button
              className="action-red"
              disabled={!!busy}
              onClick={() => void perform("remove")}
            >
              {busy === "remove" ? "Removing…" : "Confirm removal"}
            </button>
          </div>
        </div>
      ) : null}
      {!serverManaged && storageReady === false ? (
        <p className="inner-error" role="alert">
          Set up secure key storage first. For local SQLite run{" "}
          <code>npm run setup:openai</code>. On a shared server configure the
          vault secret on the app and worker.
        </p>
      ) : null}
      {issue || status?.error || status?.connection?.error ? (
        <p className="inner-error" role="alert">
          {issue || status?.error || status?.connection?.error}
        </p>
      ) : null}
      {status?.connection?.checkedAt ? (
        <p className="inner-caption">
          Last tested {new Date(status.connection.checkedAt).toLocaleString()}
        </p>
      ) : null}
      {notice ? (
        <p className="inner-notice" role="status">
          {notice}
        </p>
      ) : null}
      <p className="inner-caption">
        {serverManaged
          ? "Credentials stay in server configuration. "
          : "Encrypted on the server. Saved keys are never shown again. "}
        Connection testing uses a small paid API request and submits no trades.
      </p>
      <a
        className="inner-text-link"
        href="https://platform.openai.com/settings/organization/billing/overview"
        target="_blank"
        rel="noopener noreferrer"
      >
        OpenAI API billing ↗
      </a>
      <p className="inner-caption">
        {serverManaged
          ? "Billing is managed by the organization that owns the server’s OpenAI account."
          : "Sign into the organization that owns the key you saved. The app cannot sign you into that organization or pay its bill."}
      </p>
    </section>
  );
}
