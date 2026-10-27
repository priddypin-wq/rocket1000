"use client";
import Link from "next/link";
import { useEffect } from "react";
import DeadpoolAvatar from "./deadpool-avatar";
import BottomNav from "./bottom-nav";
import EngineConfiguration from "./engine-configuration";
import EmergencyStop from "./emergency-stop";
import { useOrders, brokerNumber, brokerTime } from "../../lib/use-orders";
import { useAnalysis } from "../../lib/use-workspace";
import { useAnalysisEngine, engineLabel } from "../../lib/use-analysis-engine";

export default function RobotHome() {
  const orders = useOrders();
  const analysis = useAnalysis();
  const engine = useAnalysisEngine();
  const account = orders.data?.account;
  const market = analysis.data?.market;
  const current =
    !orders.error &&
    !analysis.error &&
    !!orders.data?.connection?.fresh &&
    !!market?.fresh;
  const result = analysis.data?.latest?.result;
  const latest =
    current &&
    result &&
    result.expiresAt > (analysis.data?.serverTime || 0) &&
    result.symbol === market?.symbol
      ? result
      : null;
  const frame = analysis.data?.profile?.frames?.M5;
  const running = ["running", "scheduled", "verifying"].includes(
    engine.data?.state || "",
  );
  const executionOn =
    !engine.error &&
    !orders.error &&
    !!engine.data?.executionAuthorized &&
    !!orders.data?.permissionActive;
  const strategy = latest?.strategy;
  const symbols = orders.data?.authorizedSymbols
    .filter((s) => s.active && s.fresh)
    .map((s) => s.symbol)
    .join(" · ");
  const issue = orders.error || analysis.error || engine.error;
  const refreshOrders = orders.refresh;
  const refreshEngine = engine.refresh;
  useEffect(() => {
    const refresh = () => {
      void refreshOrders();
      void refreshEngine();
    };
    window.addEventListener("rocket-trading-stopped", refresh);
    return () => window.removeEventListener("rocket-trading-stopped", refresh);
  }, [refreshOrders, refreshEngine]);
  function openConfiguration() {
    window.dispatchEvent(new Event("rocket-open-configuration"));
  }
  return (
    <div className="robot-stage">
      <main className="robot-home adaptive-home">
        <header className="robot-top">
          <Link
            href="/"
            className="robot-wordmark"
            aria-label="ROCKET1000 home"
          >
            ROCKET<span>1000</span>
          </Link>
          <EngineConfiguration />
        </header>
        <div className="adaptive-assistant">
          <div className="adaptive-avatar">
            <DeadpoolAvatar />
          </div>
          <div>
            <p className="robot-intro">DEADPOOL EDITION</p>
            <h1>Your AI trading desk</h1>
            <p className="deadpool-status" role="status">
              {issue
                ? "Waiting for a verified server update."
                : !current
                  ? "Waiting for fresh EA market data."
                  : engine.data?.state === "suspended"
                    ? "AI suspended. Check the connection."
                    : running
                      ? executionOn
                        ? "Analyzing. Authorized risk checks remain active."
                        : "Analyzing. Broker execution is off."
                      : "EA data connected. Analysis is paused."}
            </p>
          </div>
        </div>
        <div className="adaptive-account" aria-label="Verified MT5 account">
          <span>
            {account
              ? (account.brokerName || account.server) +
                " · " +
                account.login +
                " · " +
                account.type.toUpperCase()
              : "Connect your MT5 account"}
          </span>
          <b>
            {account
              ? "Balance " +
                brokerNumber(account.balance, 2) +
                " · Equity " +
                brokerNumber(account.equity, 2) +
                " " +
                (account.currency || "")
              : "Account details appear after verification."}
          </b>
          <small>
            {orders.error
              ? "Update unavailable"
              : orders.data?.connection?.status || "Checking connection"}
          </small>
        </div>
        <EmergencyStop />
        <div className="adaptive-content">
          <section
            className="inner-card adaptive-analysis"
            aria-labelledby="live-analysis-title"
          >
            <div className="inner-card-title">
              <span id="live-analysis-title">AI LIVE ANALYSIS</span>
              <span className="inner-tag">
                {current ? engineLabel(engine.data?.state) : "DATA UNAVAILABLE"}
              </span>
            </div>
            <div className="adaptive-market-heading">
              <h2>{current ? market.symbol : "Waiting for your EA"}</h2>
              {current ? (
                <span className="settings-status">LIVE BROKER DATA</span>
              ) : null}
            </div>
            <div className="adaptive-readings">
              <div>
                <span>Direction</span>
                <strong>
                  {current && frame
                    ? frame.trend.direction === "up"
                      ? "Bullish"
                      : frame.trend.direction === "down"
                        ? "Bearish"
                        : "Range"
                    : "Unavailable"}
                </strong>
              </div>
              <div>
                <span>Volatility</span>
                <strong>
                  {current && frame?.atr14 != null
                    ? "ATR " + brokerNumber(frame.atr14)
                    : "Unavailable"}
                </strong>
              </div>
            </div>
            <p>
              {latest?.reasoning ||
                (!current
                  ? "Connect your EA for current market observations. Stale data cannot authorize new orders."
                  : analysis.data?.ai.error ||
                    engine.data?.reason ||
                    "Waiting for the next verified AI assessment.")}
            </p>
            {current && frame?.rsi14 != null ? (
              <p className="inner-caption">
                RSI {brokerNumber(frame.rsi14, 1)} · EMA{" "}
                {brokerNumber(frame.ema9)} / {brokerNumber(frame.ema21)}
              </p>
            ) : null}
            <p className="inner-caption">
              Market update:{" "}
              {current
                ? brokerTime(market.timestamp)
                : "No recent verified snapshot"}
              {latest ? " · Analysis " + brokerTime(latest.analyzedAt) : ""}
            </p>
            {issue ? (
              <p className="inner-error" role="alert">
                {issue}
              </p>
            ) : null}
            <div className="engine-actions">
              <button
                className="action-outline"
                disabled={engine.busy}
                onClick={() =>
                  void engine.action({
                    action: running ? "stop" : "start-analysis",
                  })
                }
              >
                {engine.busy
                  ? "Updating…"
                  : running
                    ? "Pause AI"
                    : "Resume Analysis"}
              </button>
              <button
                className="inner-text-link"
                type="button"
                onClick={openConfiguration}
              >
                Connection details
              </button>
            </div>
          </section>
          <section
            className="inner-card adaptive-strategy"
            aria-labelledby="active-strategy-title"
          >
            <div className="inner-card-title">
              <span id="active-strategy-title">ACTIVE STRATEGY</span>
              <span className="inner-tag">ADAPTIVE AI</span>
            </div>
            <h2 className="scalp-capitalize">
              {strategy?.replaceAll("-", " ") || "Waiting for analysis"}
            </h2>
            <p>
              {current
                ? latest
                  ? latest.entryConditions?.join(" · ") ||
                    "Selected from the current verified market assessment."
                  : "The AI evaluates suitable setups as fresh market data arrives."
                : "Strategy selection needs fresh authenticated EA data."}
            </p>
            <div className="inner-kv">
              <span>Automatic execution</span>
              <b>{executionOn ? "Authorized" : "OFF"}</b>
            </div>
            <p className="inner-caption">
              {executionOn
                ? "Every instruction still passes account, broker and adaptive risk checks."
                : "Analysis can run with execution OFF. Account authorization is required before orders."}
            </p>
            <button
              className={executionOn ? "action-outline" : "action-red"}
              disabled={engine.busy || !!issue}
              onClick={() => {
                if (
                  !executionOn &&
                  account?.type === "live" &&
                  !orders.data?.liveConfirmed
                )
                  openConfiguration();
                else
                  void engine.action({
                    action: executionOn ? "stop" : "start",
                  });
              }}
            >
              {engine.busy
                ? "Verifying…"
                : executionOn
                  ? "Stop Auto Trading"
                  : account?.type === "live" && !orders.data?.liveConfirmed
                    ? "Review Live Authorization"
                    : "Enable Auto Trading"}
            </button>
          </section>
          <section
            className="inner-card adaptive-signals"
            aria-labelledby="next-signal-title"
          >
            <div className="inner-card-title">
              <span id="next-signal-title">NEXT SIGNAL / OPEN ORDERS</span>
              <span className="inner-tag">{latest?.decision || "WAITING"}</span>
            </div>
            {latest ? (
              <>
                <h2>
                  {latest.symbol} · {latest.decision}
                </h2>
                <div className="adaptive-readings">
                  <div>
                    <span>Entry proposal</span>
                    <strong>{brokerNumber(latest.entryPrice)}</strong>
                  </div>
                  <div>
                    <span>Protective SL / TP</span>
                    <strong>
                      {brokerNumber(latest.stopLoss)} /{" "}
                      {brokerNumber(latest.takeProfit)}
                    </strong>
                  </div>
                </div>
                <p className="inner-caption">
                  Analysis proposal · {brokerTime(latest.analyzedAt)}
                </p>
              </>
            ) : (
              <p>No current confirmed trading setup.</p>
            )}
            <div className="inner-kv">
              <span>Broker-confirmed open orders</span>
              <b>
                {orders.data && !orders.error
                  ? orders.data.positions.length
                  : "—"}
              </b>
            </div>
            {orders.data?.brokerPending.length ? (
              <div className="inner-kv">
                <span>Broker-pending orders</span>
                <b>{orders.data.brokerPending.length}</b>
              </div>
            ) : null}
            <p className="inner-caption">
              {symbols || "No fresh connected EA symbol."}
            </p>
            {running &&
            engine.data?.scheduler?.configured &&
            engine.data.nextCycle ? (
              <p className="inner-caption">
                Next scheduled analysis: {brokerTime(engine.data.nextCycle)}
              </p>
            ) : null}
            <Link className="inner-text-link" href="/dashboard">
              View verified orders & results →
            </Link>
          </section>
        </div>
        <BottomNav active="Home" />
      </main>
    </div>
  );
}
