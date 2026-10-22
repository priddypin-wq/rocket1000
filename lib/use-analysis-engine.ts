"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { mt5Api } from "./mt5-client";

export type AnalysisEngineStatus = {
  state: "stopped" | "verifying" | "scheduled" | "running" | "suspended";
  reason?: string | null;
  lastCycle?: number | null;
  nextCycle?: number | null;
  frequencySeconds: number;
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
  const [data, setData] = useState<AnalysisEngineStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const active = useRef(false);
  const request = useRef(0);
  const polling = useRef(false);
  const mutating = useRef(false);
  const refresh = useCallback(async () => {
    if (polling.current || mutating.current) return;
    polling.current = true;
    const current = ++request.current;
    try {
      const next = await (await mt5Api("engine")).json();
      if (active.current && current === request.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (active.current && current === request.current)
        setError(e instanceof Error ? e.message : "Engine status unavailable");
    } finally {
      polling.current = false;
    }
  }, []);
  useEffect(() => {
    active.current = true;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active.current = false;
      request.current += 1;
      window.clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);
  const action = useCallback(async (body: Record<string, unknown>) => {
    mutating.current = true;
    setBusy(true);
    setPendingAction(String(body.action || ""));
    setError("");
    const current = ++request.current;
    try {
      const next = await (await mt5Api("engine", body)).json();
      if (active.current && current === request.current) setData(next);
      return true;
    } catch (e) {
      if (active.current && current === request.current)
        setError(
          e instanceof Error ? e.message : "Engine action was not confirmed",
        );
      return false;
    } finally {
      if (current === request.current) {
        mutating.current = false;
        if (active.current) {
          setBusy(false);
          setPendingAction("");
        }
      }
    }
  }, []);
  return { data, error, busy, pendingAction, refresh, action };
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
