"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { mt5Api } from "./mt5-client";

export type VerifiedAccount = {
  login: string;
  server: string;
  type: "demo" | "live";
  balance: number | null;
  equity: number | null;
  currency: string | null;
  brokerName: string | null;
  dailyProfitLoss: number | null;
  margin?: number | null;
  freeMargin?: number | null;
  marginLevel?: number | null;
  floatingProfit?: number | null;
  positionsCount?: number | null;
  ordersCount?: number | null;
  tradingAllowed?: boolean;
};
export type ManagedPosition = {
  symbol: string;
  side: "BUY" | "SELL";
  ticket: string;
  identifier: string;
  volume: number;
  open: number;
  currentPrice: number | null;
  profit: number;
  stop: number;
  takeProfit: number;
  openedAt: number | null;
  managed: true;
  status: "Open" | "Requires attention";
  fresh: boolean;
  receivedAt: number;
  canClose: boolean;
  closeBlocker?: string | null;
  account: Pick<VerifiedAccount, "login" | "server" | "type" | "currency">;
};
export type OrderDashboard = {
  serverTime: number;
  connection: {
    id: string;
    installationId?: string | null;
    sessionId?: string | null;
    status: string;
    fresh: boolean;
    lastHeartbeat: number | null;
  } | null;
  account: VerifiedAccount | null;
  accountKey: string;
  authorizedSymbols: {
    symbol: string;
    bid: number | null;
    ask: number | null;
    receivedAt: number;
    fresh: boolean;
    active: boolean;
  }[];
  positions: ManagedPosition[];
  opportunities: {
    id: string;
    symbol: string;
    decision: "BUY" | "SELL";
    status: string;
    entryPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    strategy: string;
    confidence: number | null;
    reasoning: string;
    analyzedAt: number;
    expiresAt: number;
  }[];
  latestSignal: {
    id: string;
    symbol: string;
    decision: "BUY" | "SELL" | "WAIT";
    aiDecision?: "BUY" | "SELL" | "WAIT" | "HOLD" | "CLOSE";
    entryConditions?: string[];
    strategy: string;
    reasoning: string;
    analyzedAt: number;
    expiresAt: number;
  } | null;
  brokerPending: {
    ticket: string;
    symbol: string;
    side: string;
    volume: number;
    price: number;
    stop: number;
    takeProfit: number;
    createdAt: number;
    status: string;
  }[];
  history: {
    ticket: string;
    order: string;
    positionIdentifier: string;
    symbol: string;
    side: string;
    entry: string;
    reason: string;
    volume: number;
    price: number;
    profit: number;
    commission: number;
    swap: number;
    fee: number;
    time: number;
  }[];
  performance: {
    available: boolean;
    complete?: boolean;
    scope?: string;
    currency?: string;
    from?: number;
    to?: number;
    closedDeals?: number;
    wins?: number;
    losses?: number;
    netProfit?: number;
  };
  ai: {
    state: string;
    checkedAt?: number | null;
    lastSuccessAt?: number | null;
    error?: string | null;
  };
  automation: {
    state: string;
    waiting?: boolean;
    lastCycle?: number;
    lastError?: string | null;
  } | null;
  risk: {
    dailyLoss: number;
    realizedToday: number | null;
    drawdownPct: number | null;
  } | null;
  blockers: string[];
  permissionActive: boolean;
  liveConfirmed: boolean;
};

export function brokerNumber(value: number | null | undefined, digits = 5) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "—";
}
export function brokerTime(value: number | null | undefined) {
  return typeof value === "number" && value > 0
    ? new Date(value).toLocaleString()
    : "Not reported";
}
export function useOrders() {
  const [data, setData] = useState<OrderDashboard | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    pending.current = (async () => {
      try {
        const next: OrderDashboard = await (await mt5Api("orders")).json();
        if (mounted.current) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (mounted.current)
          setError(e instanceof Error ? e.message : "Broker data unavailable");
      } finally {
        pending.current = null;
      }
    })();
    return pending.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);
  return { data, error, refresh };
}
