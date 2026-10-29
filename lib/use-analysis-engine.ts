"use client";
import { useEffect, useSyncExternalStore } from "react";
import { engineControls } from "./engine-control";

export type AnalysisEngineStatus = {
  state: "stopped" | "verifying" | "scheduled" | "running" | "suspended";
  reason?: string | null;
  lastCycle?: number | null;
  nextCycle?: number | null;
  frequencySeconds: number;
  mode?: "analysis" | "execution";
  executionAuthorized?: boolean;
  controlRevision?: string;
  accountKey?: string | null;
  installationId?: string | null;
  sessionId?: string | null;
  automaticAnalysis?: {
    paused: boolean;
    nextAttempt: number | null;
    reason: string | null;
  };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number;
    reservedUsd: number;
    dailyBudgetUsd: number;
  };
  scheduler?: { configured: boolean; mode: string };
};

export function useAnalysisEngine() {
  const state = useSyncExternalStore(
    engineControls.subscribe,
    engineControls.getSnapshot,
    engineControls.getServerSnapshot,
  );
  const refresh = engineControls.refresh;
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);
  return {
    data: state.data as AnalysisEngineStatus | null,
    error: state.error,
    busy: state.busy,
    pendingAction: state.pendingAction,
    refresh,
    action: engineControls.action,
  };
}

export function engineLabel(state?: AnalysisEngineStatus["state"]) {
  return state === "verifying"
    ? "Verifying connection"
    : state === "running"
      ? "Analyzing"
      : state === "scheduled"
        ? "Monitoring"
        : state === "suspended"
          ? "Suspended"
          : state === "stopped"
            ? "Stopped"
            : "Checking";
}
