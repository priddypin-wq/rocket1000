"use client";

import { useEffect, useRef, useState } from "react";

type Preferences = {
  version: 1;
  connectionAlerts: boolean;
  tradeUpdates: boolean;
};

export type SettingsNotificationEvent = { id: string; message: string };

const STORAGE_KEY = "rocket1000.settings.notifications.v1";
const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  connectionAlerts: true,
  tradeUpdates: true,
};

function savedPreferences(value: unknown): value is Preferences {
  if (!value || typeof value !== "object") return false;
  const preferences = value as Partial<Preferences>;
  return (
    preferences.version === 1 &&
    typeof preferences.connectionAlerts === "boolean" &&
    typeof preferences.tradeUpdates === "boolean"
  );
}

export default function SettingsNotifications({
  connectionStatus,
  events,
}: {
  connectionStatus: string | null;
  events: SettingsNotificationEvent[];
}) {
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [ready, setReady] = useState(false);
  const [persistent, setPersistent] = useState(true);
  const [notice, setNotice] = useState({ sequence: 0, message: "" });
  const initialized = useRef(false);
  const previousStatus = useRef<string | null>(null);
  const knownEvents = useRef(new Map<string, string>());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const value: unknown = JSON.parse(stored);
          if (savedPreferences(value)) setPreferences(value);
        }
      } catch {
        setPersistent(false);
      }
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready || connectionStatus === null) return;

    // The first loaded snapshot contains history, not new notifications.
    if (!initialized.current) {
      initialized.current = true;
      previousStatus.current = connectionStatus;
      for (const event of events) {
        knownEvents.current.set(event.id, event.message);
      }
      return;
    }

    const messages: string[] = [];
    if (
      preferences.connectionAlerts &&
      previousStatus.current !== connectionStatus
    ) {
      messages.push(`MT5 connection: ${connectionStatus}.`);
    }
    previousStatus.current = connectionStatus;

    const newEvents: SettingsNotificationEvent[] = [];
    for (const event of events) {
      if (knownEvents.current.get(event.id) !== event.message) {
        newEvents.push(event);
      }
      knownEvents.current.set(event.id, event.message);
    }
    // Track events even with alerts off so enabling them never replays history.
    if (preferences.tradeUpdates && newEvents.length > 0) {
      messages.push(...newEvents.slice(0, 3).map((event) => event.message));
      if (newEvents.length > 3) {
        messages.push(
          `${newEvents.length - 3} more trade updates in Execution logs.`,
        );
      }
    }
    if (messages.length > 0) {
      const timer = window.setTimeout(
        () =>
          setNotice((previous) => ({
            sequence: previous.sequence + 1,
            message: messages.join(" "),
          })),
        0,
      );
      return () => window.clearTimeout(timer);
    }
  }, [ready, connectionStatus, events, preferences]);

  function toggle(key: "connectionAlerts" | "tradeUpdates") {
    const next: Preferences = { ...preferences, [key]: !preferences[key] };
    setPreferences(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setPersistent(true);
    } catch {
      setPersistent(false);
    }
  }

  return (
    <section
      className="inner-card settings-card settings-notifications"
      id="settings-notifications"
      aria-labelledby="settings-notifications-title"
    >
      <span className="settings-eyebrow">STAY INFORMED</span>
      <h2 id="settings-notifications-title">Notifications</h2>
      {(
        [
          ["connectionAlerts", "Connection alerts"],
          ["tradeUpdates", "Trade updates"],
        ] as const
      ).map(([key, label]) => (
        <div className="settings-notification-row" key={key}>
          <span id={`notification-${key}`}>{label}</span>
          <button
            type="button"
            className="settings-toggle live-switch"
            role="switch"
            aria-checked={preferences[key]}
            aria-labelledby={`notification-${key}`}
            disabled={!ready}
            onClick={() => toggle(key)}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      ))}
      <p className="inner-caption">
        In-app alerts while this page is open.{" "}
        {persistent
          ? "Preferences are saved on this device."
          : "Preferences apply to this tab; browser storage is unavailable."}
      </p>
      <p
        className="inner-caption"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span key={notice.sequence}>{notice.message}</span>
      </p>
    </section>
  );
}
