"use client";

import { useEffect, useRef, useState } from "react";
import { mt5Api } from "../../lib/mt5-client";

type ConnectionState = {
  configured: boolean;
  provider: string;
  model: string;
  state: "unconfigured" | "configured" | "testing" | "connected" | "error";
  connected: boolean;
  checkedAt: number | null;
  lastSuccessAt: number | null;
  errorCode: string | null;
  error: string | null;
};

async function connectionStatus(test = false): Promise<ConnectionState> {
  const response = await mt5Api("ai-connection", test ? {} : undefined);
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("configured" in data) ||
    typeof data.configured !== "boolean" ||
    !("connected" in data) ||
    typeof data.connected !== "boolean" ||
    !("state" in data) ||
    !["unconfigured", "configured", "testing", "connected", "error"].includes(
      String(data.state),
    )
  ) {
    throw new Error("The server returned an invalid AI connection status.");
  }
  return data as ConnectionState;
}

function checkedTime(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toLocaleString()
    : "Not tested yet";
}

export default function AiConnectionTest({
  compact = false,
}: {
  compact?: boolean;
}) {
  const [status, setStatus] = useState<ConnectionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [issue, setIssue] = useState("");
  const request = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const current = ++request.current;
    void connectionStatus()
      .then((data) => {
        if (mounted.current && request.current === current) setStatus(data);
      })
      .catch(() => {
        if (mounted.current && request.current === current)
          setIssue(
            "Could not read the AI connection status. Try the test again.",
          );
      })
      .finally(() => {
        if (mounted.current && request.current === current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      testing ||
      (status?.state !== "testing" && status?.state !== "connected")
    )
      return;
    const current = request.current;
    const timer = window.setTimeout(
      () => {
        void connectionStatus()
          .then((data) => {
            if (mounted.current && request.current === current) setStatus(data);
          })
          .catch(() => {
            if (mounted.current && request.current === current) {
              setIssue("Could not refresh the connection test. Try again.");
              setStatus((previous) =>
                previous
                  ? { ...previous, state: "error", connected: false }
                  : null,
              );
            }
          });
      },
      status.state === "testing" ? 2000 : 60_000,
    );
    return () => window.clearTimeout(timer);
  }, [status, testing]);

  async function testConnection() {
    const current = ++request.current;
    setTesting(true);
    setIssue("");
    try {
      const data = await connectionStatus(true);
      if (mounted.current && request.current === current) setStatus(data);
    } catch (error) {
      if (mounted.current && request.current === current)
        setIssue(
          error instanceof Error
            ? error.message
            : "The AI connection test failed.",
        );
      try {
        const data = await connectionStatus();
        if (mounted.current && request.current === current) setStatus(data);
      } catch {
        // Preserve the previous status; never infer success from a failed request.
      }
    } finally {
      if (mounted.current && request.current === current) {
        setTesting(false);
        setLoading(false);
      }
    }
  }

  const busy = testing || status?.state === "testing";
  const connected = !issue && status?.connected && status.state === "connected";
  const label = busy
    ? "Testing AI connection…"
    : loading
      ? "Checking server"
      : issue
        ? "Connection unavailable"
        : connected
          ? "AI Connected"
          : status?.state === "error"
            ? "AI Connection Error"
            : status?.configured
              ? "Configured · test required"
              : "AI setup required";

  return (
    <section
      className="inner-card"
      id="ai-connection"
      aria-label="AI connection"
    >
      <div className="inner-card-title">
        <span>AI CONNECTION</span>
        <span className="inner-tag">SERVER ONLY</span>
      </div>
      <h3 role="status" aria-live="polite">
        {label}
      </h3>
      <details
        className="settings-inline-details"
        open={compact ? undefined : true}
      >
        <summary>Connection details</summary>
        <div className="inner-kv">
          <span>Provider</span>
          <b>{status?.provider || "Checking"}</b>
        </div>
        <div className="inner-kv">
          <span>Model</span>
          <b>{status?.model || "Checking"}</b>
        </div>
        <div className="inner-kv">
          <span>Last checked</span>
          <b>{checkedTime(status?.checkedAt)}</b>
        </div>
      </details>
      <button
        className="action-red"
        type="button"
        disabled={loading || busy || status?.configured === false}
        onClick={() => void testConnection()}
      >
        {busy ? "Testing…" : "Test AI connection"}
      </button>
      <p className="inner-caption">
        No trades are placed. This sends a small diagnostic request to your
        configured AI provider. MT5 does not need to be connected. API keys stay
        on the server.
      </p>
      {issue || status?.error ? (
        <p className="inner-error" role="alert">
          {issue || status?.error}
          {!issue && status?.errorCode ? ` (${status.errorCode})` : ""}
        </p>
      ) : null}
    </section>
  );
}
