import type { Bar, Timeframe } from "./use-workspace";
import type { BrokerChartData, PrivateReport } from "./private-report-types";
export type CandleGeometry = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  from: number;
  to: number;
  min: number;
  max: number;
  candles: (Bar & {
    x: number;
    wickTop: number;
    wickBottom: number;
    bodyTop: number;
    bodyBottom: number;
    bodyWidth: number;
    rising: boolean;
  })[];
  ticks: { price: number; y: number }[];
  quotes: { label: string; price: number; y: number }[];
};
export function candleGeometry(
  chart: BrokerChartData,
  timeframe: Timeframe,
  options?: { limit?: number; width?: number; height?: number },
): CandleGeometry | null;
export function chartIsFresh(
  report: PrivateReport | null,
  elapsedMs: number,
): boolean;
export function brokerClock(value: number, seconds?: boolean): string;
