"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import EmergencyStop from "./emergency-stop";

const EngineDiagnostics = dynamic(() => import("./engine-diagnostics"), {
  loading: () => <p role="status">Loading private engine diagnostics…</p>,
});

export default function EngineConfiguration() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const hash = () => {
      if (window.location.hash === "#ai-configuration") show();
    };
    hash();
    window.addEventListener("rocket-open-configuration", show);
    window.addEventListener("hashchange", hash);
    return () => {
      window.removeEventListener("rocket-open-configuration", show);
      window.removeEventListener("hashchange", hash);
    };
  }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  function close() {
    setOpen(false);
    if (window.location.hash === "#ai-configuration")
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
  }
  return (
    <>
      <button
        type="button"
        className="robot-settings"
        aria-label="AI engine configuration"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="m10 3-.6 2.5-2 .9-2.3-.8-2 3.5 1.7 1.8v2.2L3.1 15l2 3.5 2.3-.8 2 .9.6 2.4h4l.6-2.4 2-.9 2.3.8 2-3.5-1.7-1.9v-2.2l1.7-1.8-2-3.5-2.3.8-2-.9L14 3z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      <dialog
        ref={dialog}
        className="engine-drawer"
        aria-labelledby="engine-drawer-title"
        onCancel={close}
        onClose={close}
      >
        <div className="engine-drawer-header">
          <div>
            <h2 id="engine-drawer-title">AI Engine Configuration</h2>
            <p>Private administration & diagnostics</p>
          </div>
          <button
            type="button"
            className="drawer-close"
            aria-label="Close AI engine configuration"
            onClick={close}
          >
            ×
          </button>
          <EmergencyStop compact />
        </div>
        <div className="engine-drawer-content">
          {open ? <EngineDiagnostics /> : null}
        </div>
      </dialog>
    </>
  );
}
