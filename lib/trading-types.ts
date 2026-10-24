import type { AdaptiveProfile, TradingMode } from "./use-workspace";

export type TradeSettings = {
  strategy: "adaptive" | "price-action" | "scalping";
  tradingMode: TradingMode;
  sizingMode: "adaptive" | "capped";
  lotSize: number;
  stopLossPoints: number;
  takeProfitPoints: number;
  trailingStopPoints: number;
  breakEvenPoints: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxPositions: number;
  minConfidence: number;
  intervalSeconds: number;
  maxSpreadPoints: number;
  maxSlippagePoints: number;
};
export type AutoState = {
  account: null | { login: string; server: string; type: "demo" | "live" };
  accountKey: string;
  liveConfirmed: boolean;
  liveConfirmedAt?: number | null;
  sessionId?: string | null;
  installationId?: string | null;
  settingsRevision?: string;
  activationEvents?: { event: string; createdAt: number }[];
  demoValidation: {
    passed: boolean;
    engineVersion: string;
    completedAt: number | null;
  };
  profile: AdaptiveProfile | null;
  sizing: null | {
    mode: "adaptive" | "capped";
    basisBalance: number;
    riskBudget: number;
    currency: string;
    lotCap: number;
  };
  performance: {
    available: boolean;
    from?: number;
    to?: number;
    closedDeals?: number;
    wins?: number;
    losses?: number;
    grossProfit?: number;
    grossLoss?: number;
    netProfit?: number;
    currency?: string;
  };
  connectionBlockers: string[];
  permissionActive: boolean;
  settings: TradeSettings;
  automation: null | {
    state: string;
    waiting?: boolean;
    lastCycle: number;
    lastError: string | null;
  };
  risk: null | {
    dailyLoss: number;
    realizedToday: number | null;
    drawdownPct: number | null;
  };
};
