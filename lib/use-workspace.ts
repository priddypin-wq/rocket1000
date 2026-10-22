"use client";
import { useEffect, useState } from "react";
import { mt5Api } from "./mt5-client";
export type Timeframe = "M1" | "M5" | "M15" | "H1";
export type TradingMode = "balanced" | "aggressive";
export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type Indicators = {
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  atr14: number | null;
  rsi14: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  support: number | null;
  resistance: number | null;
  trend: { direction: "up" | "down" | "range"; strength: number };
  volatilityRatio: number | null;
};
export type AdaptiveProfile = {
  ready: boolean;
  mode: TradingMode;
  regime: string;
  effectiveRiskPct: number;
  minConfidence: number;
  minRewardRisk: number;
  scalpingEligible: boolean;
  scalpingReason: string;
  allowedStrategies: string[];
  decisionTimeframe: "M1";
  decisionBarTime: number;
  frames: Partial<Record<Timeframe, Indicators | null>>;
};
export type Market = {
  symbol: string;
  bid: number;
  ask: number;
  balance: number;
  equity: number;
  currency: string;
  timestamp: number;
  receivedAt: number;
  fresh: boolean;
  positions: {
    symbol: string;
    side: string;
    volume: number;
    open: number;
    stop: number;
    takeProfit: number;
    profit: number;
  }[];
  bars: Bar[];
  timeframes?: Partial<Record<Timeframe, { bars: Bar[] }>>;
};
export type AnalysisResult = {
  decision: "BUY" | "SELL" | "WAIT";
  confidence: number;
  strategy: string;
  reasoning: string;
  risks: string[];
  model: string;
  provider: string;
  analyzedAt: number;
  marketTimestamp: number;
  symbol: string;
  engineVersion: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  timeframe: Timeframe;
  expiresAt: number;
  profile: AdaptiveProfile;
  mode: TradingMode;
  regime: string;
  executionApproved: false;
  proposedLots?: number | null;
  entryAction?: "OPEN" | "ADD" | "NONE";
  positionActions?: {
    kind: "KEEP" | "MODIFY" | "PARTIAL_CLOSE" | "CLOSE";
    position: string;
    volume: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    reasoning: string;
  }[];
  executionBlockers: string[];
};
export type AnalysisEntry = {
  id: string;
  status: string;
  result: AnalysisResult | null;
  error: string | null;
  createdAt: number;
};
export type AnalysisState = {
  serverTime: number;
  ai: {
    model: string;
    provider: string;
    configured: boolean;
    state: "unconfigured" | "configured" | "analyzing" | "connected" | "error";
    errorCode?: string | null;
    error?: string | null;
    lastSuccessAt?: number | null;
    checkedAt?: number | null;
  };
  accountType: "demo" | "live" | null;
  market: Market | null;
  profile: AdaptiveProfile | null;
  latest: AnalysisEntry | null;
  history: AnalysisEntry[];
};
export function useAnalysis() {
  const [data, setData] = useState<AnalysisState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const state = await (await mt5Api("analysis")).json();
        if (active) {
          setData(state);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "Server unavailable");
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return { data, error, setData };
}
