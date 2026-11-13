import type { Bar, Timeframe } from "./use-workspace";

export type BrokerChartData = {
  source: string;
  symbol: string;
  bid: number;
  ask: number;
  timestamp: number;
  brokerTimestamp: number;
  quoteTimestamp: number;
  receivedAt: number;
  freshUntil: number;
  closedCandles: true;
  timeframes: Partial<Record<Timeframe, { bars: Bar[] }>>;
};

export type PrivateReport = {
  version: number;
  generatedAt: number;
  accountKey?: string;
  scope: string;
  historyComplete: false;
  connection: { status: string; fresh: boolean; lastHeartbeat: number | null };
  account: {
    login: string;
    server: string;
    type: "demo" | "live";
    currency: string | null;
  } | null;
  chart: BrokerChartData | null;
  summary: string;
};
