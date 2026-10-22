"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";
import { mt5Api } from "../../lib/mt5-client";
import DeadpoolAvatar from "./deadpool-avatar";
import BottomNav from "./bottom-nav";
import { useOrders, brokerNumber } from "../../lib/use-orders";
import { useAnalysisEngine, engineLabel } from "../../lib/use-analysis-engine";

function Icon({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export default function RobotHome() {
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState("");
  const { data, error, refresh } = useOrders();
  const engine = useAnalysisEngine();
  const running =
    engine.data?.state === "running" ||
    engine.data?.state === "scheduled" ||
    engine.data?.state === "verifying" ||
    engine.pendingAction === "start";
  const account = data?.account;
  const symbol = data?.authorizedSymbols.map((s) => s.symbol).join(" · ");
  const latest = data?.latestSignal;
  const assistantStatus = error
    ? "Waiting for the server."
    : engine.data?.state === "verifying" || engine.pendingAction === "start"
      ? "Verifying the AI and broker connection."
      : engine.data?.state === "running"
        ? "Analyzing the market."
        : data?.automation?.waiting
          ? "Risk protection is waiting for safety checks."
          : engine.data?.state === "suspended"
            ? "AI suspended. Review the engine status."
            : running
              ? "Monitoring your connected EA."
              : data?.connection?.status === "Connected"
                ? "EA connected. AI paused."
                : "Waiting for your EA connection.";
  async function pause() {
    await engine.action({ action: "stop" });
    await refresh();
  }
  async function emergencyStop() {
    setBusy(true);
    setIssue("");
    try {
      await mt5Api("stop", {});
      await refresh();
      setIssue(
        "Emergency Stop confirmed. New orders stopped; existing positions remain open.",
      );
    } catch (e) {
      setIssue(
        e instanceof Error ? e.message : "Stop was not confirmed. Check MT5.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    await engine.action({ action: "start" });
    await refresh();
  }
  return (
    <div className="robot-stage">
      <main className="robot-home">
        <header className="robot-top">
          <Link
            href="/"
            className="robot-wordmark"
            aria-label="ROCKET1000 home"
          >
            ROCKET<span>1000</span>
          </Link>
          <Link
            className="robot-settings"
            href="/settings"
            aria-label="Risk and strategy settings"
          >
            <Icon>
              <path d="M4 7h16M4 17h16" />
              <circle cx="8" cy="7" r="3" />
              <circle cx="16" cy="17" r="3" />
            </Icon>
          </Link>
        </header>
        <section
          className="robot-hero"
          aria-label="ROCKET1000 Deadpool edition"
        >
          <div className="robot-orbit">
            <DeadpoolAvatar className="robot-portrait" />
            <span className="robot-edition">DEADPOOL EDITION</span>
          </div>
          <p className="robot-intro">Your trading robot</p>
          <h1>
            ROCKET1000 <span>AI</span>
          </h1>
          <p className="robot-powered">PRECISION. CONTROL. NO MERCY.</p>
          <div className="robot-controls" aria-label="Robot controls">
            <Link href="/mt5" className="robot-control">
              <span className="robot-control-icon">
                <Icon>
                  <rect x="6" y="3" width="12" height="18" rx="2" />
                  <path d="M10 17h4M10 6h4" />
                </Icon>
              </span>
              <span>CONNECT</span>
            </Link>
            <Link href="/dashboard" className="robot-control">
              <span className="robot-control-icon">
                <Icon>
                  <path d="M9 6h11M9 12h11M9 18h11" />
                  <path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="3" />
                </Icon>
              </span>
              <span>ORDERS</span>
            </Link>
          </div>
          <p className="robot-lock">
            <Icon>
              <rect x="6" y="10" width="12" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </Icon>{" "}
            OpenAI analysis · Verified MT5 data
          </p>
          <p className="deadpool-status" role="status">
            {assistantStatus}
          </p>
          <button
            className="action-red engine-start"
            disabled={busy || (engine.busy && engine.pendingAction !== "start")}
            onClick={() => void (running ? pause() : start())}
          >
            {engine.busy && engine.pendingAction !== "start"
              ? "STOPPING…"
              : running
                ? "STOP AI"
                : "START AI"}
          </button>
          <p className="engine-start-caption">
            Starts analysis. Broker execution requires separate account
            authorization in Settings.
          </p>
          {issue || engine.error ? (
            <div className="home-analysis-error" role="alert">
              {issue || engine.error}
              <Link href="/settings#ai-connection">
                Check AI connection & security →
              </Link>
            </div>
          ) : null}
        </section>
        <section
          className="home-account inner-card"
          aria-label="Verified account dashboard"
        >
          <div className="inner-card-title">
            <span>YOUR MT5 ACCOUNT</span>
            <span className="inner-tag">
              {account?.type?.toUpperCase() || "NOT VERIFIED"}
            </span>
          </div>
          <h2>
            {account
              ? account.brokerName || account.server
              : "Connect your terminal"}
          </h2>
          <p className="inner-caption">
            {account
              ? `${account.login} · ${data?.connection?.status || "Disconnected"}`
              : "Actual account details appear after EA verification."}
          </p>
          <div className="home-account-grid">
            <div>
              <span>Balance</span>
              <strong>
                {brokerNumber(account?.balance, 2)}{" "}
                <small>{account?.currency}</small>
              </strong>
            </div>
            <div>
              <span>Equity</span>
              <strong>
                {brokerNumber(account?.equity, 2)}{" "}
                <small>{account?.currency}</small>
              </strong>
            </div>
            <div>
              <span>Daily P/L</span>
              <strong>{brokerNumber(account?.dailyProfitLoss, 2)}</strong>
            </div>
            <div>
              <span>Rocket1000 positions</span>
              <strong>
                {data && account
                  ? data.positions.filter(
                      (p) =>
                        p.account.login === account.login &&
                        p.account.server === account.server,
                    ).length
                  : "—"}
              </strong>
            </div>
          </div>
          <div className="inner-kv">
            <span>EA symbol</span>
            <b>{symbol || "Waiting for EA"}</b>
          </div>
          <div className="inner-kv">
            <span>AI status</span>
            <b>
              {error || engine.error
                ? "Unavailable"
                : engineLabel(engine.data?.state)}
            </b>
          </div>
          <div className="inner-kv">
            <span>Latest verified signal</span>
            <b>
              {latest
                ? `${latest.symbol} · ${latest.decision}`
                : "No current verified signal"}
            </b>
          </div>
          <details className="settings-inline-details">
            <summary>Verified trading performance</summary>
            {data?.performance.available ? (
              <>
                <div className="inner-kv">
                  <span>Closed broker deals</span>
                  <b>{data.performance.closedDeals ?? "—"}</b>
                </div>
                <div className="inner-kv">
                  <span>Net realized P/L</span>
                  <b>
                    {brokerNumber(data.performance.netProfit, 2)}{" "}
                    {data.performance.currency}
                  </b>
                </div>
                <p className="inner-caption">
                  Based on verified Rocket1000 broker deals shown, up to 100.
                  This is an observed history summary, not an all-time result.
                </p>
              </>
            ) : (
              <p>Waiting for verified Rocket1000 broker deal history.</p>
            )}
          </details>
          {error ? (
            <p className="inner-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="home-trading-actions home-emergency-action">
            <button
              className="action-red"
              disabled={busy}
              onClick={() => void emergencyStop()}
            >
              Emergency Stop
            </button>
          </div>
        </section>
        <section
          className="inner-card engine-activity"
          aria-label="AI engine activity"
        >
          <div className="inner-card-title">
            <span>ENGINE ACTIVITY</span>
            <span className="inner-tag">
              {engineLabel(
                engine.pendingAction === "start"
                  ? "verifying"
                  : engine.data?.state,
              ).toUpperCase()}
            </span>
          </div>
          <p>
            {engine.data?.reason ||
              (engine.pendingAction === "start" ||
              engine.data?.state === "verifying"
                ? "Verifying access before scheduling analysis."
                : engine.data?.state === "scheduled" ||
                    engine.data?.state === "running"
                  ? "Monitoring authenticated EA market data."
                  : "Save and verify your OpenAI key, connect MT5, then press START AI.")}
          </p>
          <div className="inner-kv">
            <span>Last analysis cycle</span>
            <b>
              {engine.data?.lastCycle
                ? new Date(engine.data.lastCycle).toLocaleString()
                : "Not run yet"}
            </b>
          </div>
          <div className="inner-kv">
            <span>Background service</span>
            <b>
              {engine.data?.scheduler?.configured
                ? engine.data.scheduler.mode
                : "Setup required"}
            </b>
          </div>
          {engine.data?.usage ? (
            <div className="inner-kv">
              <span>Estimated API usage today</span>
              <b>
                ${engine.data.usage.estimatedUsd.toFixed(4)} / $
                {engine.data.usage.dailyBudgetUsd.toFixed(2)}
              </b>
            </div>
          ) : null}
          {latest ? (
            <p className="inner-caption">
              {latest.symbol} · {latest.decision} · {latest.reasoning}
            </p>
          ) : null}
          <Link className="inner-text-link" href="/dashboard">
            Analysis, signals & results →
          </Link>
        </section>
        <div className="robot-bottom-space">
          <span className="robot-small-line" />
          <p>YOUR EDGE. YOUR RULES.</p>
        </div>
        <BottomNav active="Home" />
      </main>
    </div>
  );
}
