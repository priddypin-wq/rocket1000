"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { mt5Api } from "./mt5-client";

export type AutonomousStatus = {
  state: "waiting" | "monitoring" | "paused" | "blocked";
  enabled: boolean;
  account: { login: string; server: string; type: "demo" | "live" } | null;
  direction: "bullish" | "bearish" | "neutral" | null;
  activeStrategy?: "scalping" | "trend" | "breakout" | "reversal" | "wait";
  regime: string | null;
  currentScalp: {
    ticket: string;
    symbol: string;
    side: "BUY" | "SELL";
    entry: number;
    stop: number;
    takeProfit: number;
    currentPrice: number | null;
    volume: number;
    profit: number;
  } | null;
  dailyPnl: number | null;
  completedScalps: number | null;
  risk: {
    perTradePct: number;
    aggregatePct: number;
    maxPositions: number;
    dailyLossPct: number;
    consecutiveLosses: number | null;
    blocked: boolean;
    reasons: string[];
  };
  lastDecision: {
    decision: string;
    reasoning: string;
    barTime: number;
  } | null;
  lastError?: string | null;
};

export function automaticTradingLabel(state?: AutonomousStatus["state"]) {
  return state === "monitoring"
    ? "Monitoring"
    : state === "blocked"
      ? "Safety hold"
      : state === "paused"
        ? "Paused"
        : state === "waiting"
          ? "Waiting for verified data"
          : "Checking";
}

/** Reads server-owned state; mounting the dashboard never starts trading. */
export function useAutonomousStatus() {
  const [data, setData] = useState<AutonomousStatus | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const request = useRef(0);
  const polling = useRef(false);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    const current = ++request.current;
    try {
      const next: AutonomousStatus = await (await mt5Api("scalping")).json();
      if (mounted.current && current === request.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (mounted.current && current === request.current)
        setError(
          e instanceof Error ? e.message : "AI trading status unavailable",
        );
    } finally {
      polling.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      mounted.current = false;
      request.current += 1;
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);
  return { data, error, refresh };
}
