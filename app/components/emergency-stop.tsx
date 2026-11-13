"use client";
import { useRef, useState } from "react";
import { engineControls } from "../../lib/engine-control";

export default function EmergencyStop({
  compact = false,
}: {
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  async function stop() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const confirmed = await engineControls.emergencyStop();
      if (!confirmed)
        throw Error(
          engineControls.getSnapshot().error ||
            "Stop was not confirmed. Check your MT5 terminal.",
        );
      setNotice(
        "Emergency Stop confirmed. New execution is blocked; existing positions remain open. An order already sent to the broker may still complete.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Stop was not confirmed. Check your MT5 terminal.",
      );
    } finally {
      pending.current = false;
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
