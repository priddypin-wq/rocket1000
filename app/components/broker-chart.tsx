"use client";

import { useEffect, useRef, useState } from "react";
import { mt5Api } from "../../lib/mt5-client";
import { requestBrowserDownload } from "../../lib/browser-download.mjs";
import { brokerNumber } from "../../lib/use-orders";
import {
  brokerClock,
  candleGeometry,
  chartIsFresh,
} from "../../lib/broker-chart.mjs";
import type { PrivateReport } from "../../lib/private-report-types";
import type { Timeframe } from "../../lib/use-workspace";
import styles from "./broker-chart.module.css";

export function BrokerChart({
  report,
  error = "",
  elapsed = 0,
}: {
  report: PrivateReport | null;
  error?: string;
  elapsed?: number;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("M5");
  const fresh = !error && chartIsFresh(report, elapsed);
  const chart = fresh ? report?.chart : null;
  const choices = chart ? (Object.keys(chart.timeframes) as Timeframe[]) : [];
  const selected = choices.includes(timeframe) ? timeframe : choices[0];
  const geometry = chart && selected ? candleGeometry(chart, selected) : null;
  return (
    <section className="inner-card" aria-labelledby="broker-chart-title">
      <div className="inner-card-title">
        <span id="broker-chart-title">BROKER CANDLE CHART</span>
        <span className="inner-tag">
          {chart ? "AUTHENTICATED EA" : "WAITING FOR DATA"}
        </span>
      </div>
      {chart && geometry ? (
        <>
          <div className={styles.heading}>
            <h2>{chart.symbol}</h2>
            <label className={styles.frameLabel}>
              Timeframe
              <select
                value={selected}
                onChange={(event) =>
                  setTimeframe(event.target.value as Timeframe)
                }
              >
                {choices.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={styles.quotes}>
            <span>
              Bid <b>{brokerNumber(chart.bid)}</b>
            </span>
            <span>
              Ask <b>{brokerNumber(chart.ask)}</b>
            </span>
            <span>{geometry.candles.length} closed candles</span>
          </div>
          <div className={styles.plot}>
            <svg
              viewBox={`0 0 ${geometry.width} ${geometry.height}`}
              role="img"
              aria-label={`${chart.symbol} ${selected} closed broker candles. Bid ${chart.bid}, ask ${chart.ask}.`}
            >
              <title>
                {chart.symbol} · {selected} · closed candles reported by your
                MT5 EA
              </title>
              <desc>
                Prices at right. Candle times use the broker-reported clock;
                gaps are preserved. Open, high, low and close values are
                available in the candle table.
              </desc>
              {geometry.ticks.map((tick) => (
                <g key={tick.price}>
                  <line
                    x1={geometry.left}
                    x2={geometry.right}
                    y1={tick.y}
                    y2={tick.y}
                    className={styles.grid}
                  />
                  <text
                    x={geometry.right + 9}
                    y={tick.y + 4}
                    className={styles.axis}
                  >
                    {brokerNumber(tick.price)}
                  </text>
                </g>
              ))}
              {geometry.candles.map((bar) => (
                <g
                  key={bar.time}
                  className={bar.rising ? styles.rising : styles.falling}
                >
                  <title>
                    {brokerClock(bar.time, true)} · O {bar.open} H {bar.high} L{" "}
                    {bar.low} C {bar.close} · Volume {bar.volume}
                  </title>
                  <line
                    x1={bar.x}
                    x2={bar.x}
                    y1={bar.wickTop}
                    y2={bar.wickBottom}
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                  <rect
                    x={bar.x - bar.bodyWidth / 2}
                    y={bar.bodyTop}
                    width={bar.bodyWidth}
                    height={Math.max(1, bar.bodyBottom - bar.bodyTop)}
                    fill="currentColor"
                  />
                </g>
              ))}
              {geometry.quotes.map((quote) => (
                <g
                  key={quote.label}
                  className={quote.label === "bid" ? styles.bid : styles.ask}
                >
                  <line
                    x1={geometry.left}
                    x2={geometry.right}
                    y1={quote.y}
                    y2={quote.y}
                    stroke="currentColor"
                    strokeDasharray="4 5"
                  />
                </g>
              ))}
              <text
                x={geometry.left}
                y={geometry.height - 9}
                className={styles.axis}
              >
                {brokerClock(geometry.from, true).slice(0, 16)}
              </text>
              <text
                x={geometry.right}
                y={geometry.height - 9}
                className={styles.axis}
                textAnchor="end"
              >
                {brokerClock(geometry.to, true).slice(0, 16)}
              </text>
            </svg>
          </div>
          <p className="inner-caption">
            {selected} · Green rising / pink falling · Blue bid / gold ask ·
            Broker clock (UTC formatted)
          </p>
          <p className={styles.timestamps}>
            Quote {brokerClock(chart.quoteTimestamp)}
            <br />
            Received {brokerClock(chart.receivedAt)}
          </p>
          <details className={styles.candleDetails}>
            <summary>View reported OHLC values</summary>
            <div className={styles.tableScroll}>
              <table>
                <caption>
                  {chart.symbol} {selected}: latest {geometry.candles.length}{" "}
                  closed candles, broker clock
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Time (UTC formatted)</th>
                    <th scope="col">Open</th>
                    <th scope="col">High</th>
                    <th scope="col">Low</th>
                    <th scope="col">Close</th>
                    <th scope="col">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {[...geometry.candles].reverse().map((bar) => (
                    <tr key={bar.time}>
                      <th scope="row">{brokerClock(bar.time, true)}</th>
                      <td>{bar.open}</td>
                      <td>{bar.high}</td>
                      <td>{bar.low}</td>
                      <td>{bar.close}</td>
                      <td>{bar.volume}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <p>
          {error ||
            "Waiting for fresh authenticated EA candles. Connect MT5 to show its exact broker symbol and reported timeframes."}
        </p>
      )}
    </section>
  );
}

export function PrivateReports({ report }: { report: PrivateReport | null }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const actionInFlight = useRef(false);
  async function perform(action: "copy" | "download") {
    if (actionInFlight.current) return;
    if (!report?.account) {
      setNotice(
        "Connect your EA and verify its account before creating a report.",
      );
      return;
    }
    actionInFlight.current = true;
    setBusy(true);
    setNotice("");
    try {
      // Both actions fetch a new private snapshot using the HttpOnly session.
      const response = await mt5Api(
        action === "copy"
          ? "reports?format=json"
          : "reports?format=csv&download=1" +
              (report.accountKey
                ? `&expectedAccountKey=${encodeURIComponent(report.accountKey)}`
                : ""),
      );
      if (action === "copy") {
        const freshReport: PrivateReport = await response.json();
        if (
          !freshReport.account ||
          freshReport.account.login !== report.account.login ||
          freshReport.account.server !== report.account.server ||
          freshReport.account.type !== report.account.type ||
          typeof freshReport.summary !== "string" ||
          !freshReport.summary.trim()
        )
          throw new Error(
            "The verified account changed or its report is unavailable. Refresh Market before copying again.",
          );
        if (!navigator.clipboard?.writeText)
          throw new Error(
            "Clipboard access is unavailable. Use HTTPS and allow clipboard access, or download the CSV instead.",
          );
        await navigator.clipboard.writeText(freshReport.summary);
        setNotice("Private broker summary copied.");
      } else {
        const filename =
          response.headers
            .get("Content-Disposition")
            ?.match(/filename="([^"]+)"/)?.[1] || "rocket1000-report.csv";
        await requestBrowserDownload(response, {
          filename,
          contentTypes: ["text/csv"],
        });
        setNotice(
          "Private CSV download requested. Check your browser’s downloads.",
        );
      }
    } catch (error) {
      setNotice(
        error instanceof Error && error.name === "NotAllowedError"
          ? "Clipboard permission was denied. Allow clipboard access or download the CSV instead."
          : error instanceof Error
            ? error.message
            : "The private report could not be created.",
      );
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="inner-card" aria-labelledby="private-report-title">
      <div className="inner-card-title">
        <span id="private-report-title">PRIVATE REPORTS</span>
        <span className="inner-tag">YOUR ACCOUNT</span>
      </div>
      <p>
        Copy the current broker summary or download account values, owned
        positions, the latest 100 verified deals and available closed candles.
      </p>
      {report?.account ? (
        <p className="inner-caption">
          Account {report.account.login} · {report.account.server} ·{" "}
          {report.account.type.toUpperCase()}
        </p>
      ) : (
        <p className="inner-caption">
          Connect your EA to include broker account data.
        </p>
      )}
      <div className={styles.reportActions}>
        <button
          type="button"
          className="action-outline"
          disabled={busy || !report?.account}
          onClick={() => void perform("copy")}
        >
          Copy report
        </button>
        <button
          type="button"
          className="action-red"
          disabled={busy || !report?.account}
          onClick={() => void perform("download")}
        >
          Download CSV
        </button>
      </div>
      <p className="inner-caption">
        Private browser session required. History is a limited sample; stale
        values are marked in the report.
      </p>
      {notice ? (
        <p className="inner-notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

export default function BrokerMarketTools() {
  const [report, setReport] = useState<PrivateReport | null>(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const received = useRef(0);
  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      const started = performance.now();
      try {
        const next: PrivateReport = await (
          await mt5Api("reports?format=json")
        ).json();
        if (active) {
          received.current = started;
          setReport(next);
          setElapsed(performance.now() - started);
          setError("");
        }
      } catch (issue) {
        if (active)
          setError(
            issue instanceof Error
              ? issue.message
              : "Broker chart unavailable.",
          );
      } finally {
        pending = false;
      }
    }
    void refresh();
    const poll = window.setInterval(() => void refresh(), 5000);
    const clock = window.setInterval(
      () => setElapsed(performance.now() - received.current),
      1000,
    );
    return () => {
      active = false;
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, []);
  return (
    <>
      <BrokerChart report={report} error={error} elapsed={elapsed} />
    </>
  );
}
