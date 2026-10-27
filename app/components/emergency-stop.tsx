"use client";
import { useState } from "react";
import { mt5Api } from "../../lib/mt5-client";

export default function EmergencyStop({
  compact = false,
}: {
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function stop() {
    setBusy(true);
    setNotice("");
    try {
      await mt5Api("stop", {});
      setNotice(
        "Emergency Stop confirmed. New execution is blocked; existing positions remain open. An order already sent to the broker may still complete.",
      );
      window.dispatchEvent(new Event("rocket-trading-stopped"));
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Stop was not confirmed. Check your MT5 terminal.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={compact ? "emergency-control is-compact" : "emergency-control"}
    >
      <button
        type="button"
        className="emergency-stop-button"
        disabled={busy}
        onClick={() => void stop()}
      >
        {busy ? "Stopping…" : "Emergency Stop"}
      </button>
      {notice ? (
        <p role="status" className="emergency-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
