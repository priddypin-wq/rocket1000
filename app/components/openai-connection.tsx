"use client";
import { useEffect, useRef, useState } from "react";
import { mt5Api } from "../../lib/mt5-client";

type Metadata = {
  configured: boolean;
  verified?: boolean;
  state?: string;
  error?: string | null;
  model?: string | null;
  storageReady?: boolean;
  encryptionReady?: boolean;
  stored?: boolean;
  source?: string;
  connection?: {
    state?: string;
    connected?: boolean;
    error?: string | null;
    errorCode?: string | null;
  };
};

export default function OpenAiConnection() {
  const [status, setStatus] = useState<Metadata | null>(null);
  const [busy, setBusy] = useState("");
  const [issue, setIssue] = useState("");
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const current = ++generation.current;
    void mt5Api("openai")
      .then((r) => r.json())
      .then((metadata) => {
        if (mounted.current && current === generation.current)
          setStatus(metadata);
      })
      .catch((e) => {
        if (mounted.current && current === generation.current)
          setIssue(
            e instanceof Error ? e.message : "OpenAI connection unavailable",
          );
      });
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  async function perform(action: "save" | "test" | "remove") {
    setIssue("");
    setNotice("");
    // Read only at submission. Clear immediately; saved keys never populate this field.
    const key = action === "save" ? keyInput.current?.value.trim() : undefined;
    if (keyInput.current) keyInput.current.value = "";
    if (action === "save" && !key) {
      setIssue("Enter your OpenAI API key first.");
      return;
    }
    if (location.protocol !== "https:") {
      setIssue(
        "Use the secure HTTPS app to save, test or remove your API key.",
      );
      return;
    }
    setBusy(action);
    const current = ++generation.current;
    try {
      const model = modelInput.current?.value.trim();
      const metadata = await (
        await mt5Api("openai", {
          action,
          ...(action === "save" ? { key, ...(model ? { model } : {}) } : {}),
        })
      ).json();
      if (!mounted.current || current !== generation.current) return;
      setStatus(metadata);
      setRemoving(false);
      setNotice(
        action === "save"
          ? "API key saved securely. Test the connection before starting AI."
          : action === "remove"
            ? "API key removed. AI must be configured and verified before it can start."
            : metadata.verified || metadata.connection?.connected
              ? "OpenAI connection verified. No trades were submitted."
              : "Verification did not succeed. Review the connection error.",
      );
    } catch (e) {
      if (mounted.current && current === generation.current) {
        // Only the backend's sanitized message is displayed. Never reflect the submitted key.
        const message =
          e instanceof Error ? e.message : "OpenAI request failed";
        setIssue(
          key && message.includes(key)
            ? "OpenAI request failed. Check the server connection."
            : message,
        );
      }
      try {
        const metadata = await (await mt5Api("openai")).json();
        if (mounted.current && current === generation.current)
          setStatus(metadata);
      } catch {
        /* Keep the last confirmed metadata. */
      }
    } finally {
      if (mounted.current && current === generation.current) setBusy("");
    }
  }
  const verified =
    !issue && (status?.verified || status?.connection?.connected);
  const storageReady = status?.encryptionReady ?? status?.storageReady;
  return (
    <section
      className="inner-card openai-connection"
      id="ai-connection"
      aria-labelledby="openai-title"
    >
      <div className="inner-card-title">
        <span id="openai-title">OPENAI AI CONNECTION</span>
        <span
          className={`settings-status ${verified ? "is-connected" : ""}`}
          role="status"
        >
          {!status
            ? "Checking…"
            : busy === "test"
              ? "Testing…"
              : verified
                ? "Connected"
                : "Disconnected"}
        </span>
      </div>
      <p>Your paid OpenAI API account powers this engine.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform("save");
        }}
      >
        <label className="trade-field">
          {status?.configured ? "Replace API key" : "OpenAI API key"}
          <input
            ref={keyInput}
            type="password"
            name="openai-api-key"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="Enter API key"
            disabled={!!busy || storageReady === false}
            required
            data-1p-ignore="true"
            data-lpignore="true"
          />
        </label>
        <details className="settings-inline-details">
          <summary>Reasoning model</summary>
          <label className="trade-field">
            Model available to your OpenAI account
            <input
              ref={modelInput}
              name="model"
              placeholder={
                status?.model || "Use the server’s configured reasoning model"
              }
              autoComplete="off"
              disabled={!!busy}
            />
          </label>
          <p className="inner-caption">
            A real API test verifies model access. A model name alone does not
            confirm availability.
          </p>
        </details>
        <div className="engine-actions">
          <button
            className="action-red"
            type="submit"
            disabled={!!busy || storageReady === false}
          >
            {busy === "save"
              ? "Saving…"
              : status?.configured
                ? "Replace API Key"
                : "Save API Key"}
          </button>
          <button
            className="action-outline"
            type="button"
            disabled={!!busy || !status?.configured}
            onClick={() => void perform("test")}
          >
            {busy === "test" ? "Testing…" : "Test Connection"}
          </button>
        </div>
      </form>
      {status?.configured ? (
        <button
          className="inner-text-button"
          type="button"
          disabled={!!busy}
          onClick={() => setRemoving(true)}
        >
          Remove API Key
        </button>
      ) : null}
      {removing ? (
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
      {storageReady === false ? (
        <p className="inner-error" role="alert">
          Secure server encryption is not configured. Key saving remains
          unavailable until setup is complete.
        </p>
      ) : null}
      {issue || status?.error || status?.connection?.error ? (
        <p className="inner-error" role="alert">
          {issue || status?.error || status?.connection?.error}
        </p>
      ) : null}
      {notice ? (
        <p className="inner-notice" role="status">
          {notice}
        </p>
      ) : null}
      <p className="inner-caption">
        Encrypted on the server. Saved keys are never shown again. Connection
        testing uses a small paid API request and submits no trades.
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
        Sign into the organization that owns the key you saved. The app cannot
        sign you into that organization or pay its bill.
      </p>
    </section>
  );
}
