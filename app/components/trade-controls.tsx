"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { mt5Api } from "../../lib/mt5-client";
import { useAnalysisEngine } from "../../lib/use-analysis-engine";
import type { AutoState } from "../../lib/trading-types";

type State = AutoState & {
  enabled: boolean;
  expiresAt: number | null;
  positions?: unknown[];
  blockers: string[];
  market: { balance: number; equity: number; currency: string } | null;
  orders: {
    id: string;
    status: string;
    createdAt: number;
    order: { kind?: string; symbol: string; volume: number };
    result?: null | { deal: string; retcode: number; filledVolume?: number };
  }[];
};
export default function TradeControls({
  children,
  aiStatus,
}: {
  children?: ReactNode;
  aiStatus?: ReactNode;
}) {
  const [data, setData] = useState<State | null>(null);
  const [issue, setIssue] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopNotice, setStopNotice] = useState("");
  const request = useRef(0);
  const engine = useAnalysisEngine();
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const next = await (await mt5Api("trading")).json();
      if (current === request.current) {
        setData(next);
        setPollError("");
      }
    } catch (e) {
      if (current === request.current)
        setPollError(
          e instanceof Error ? e.message : "Account status unavailable",
        );
    }
  }, []);
  useEffect(() => {
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        await refresh();
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      request.current += 1;
      clearInterval(timer);
    };
  }, [refresh]);
  const action = async (body: unknown) => {
    setBusy(true);
    setIssue("");
    try {
      const result = await (await mt5Api("trading", body)).json();
      await refresh();
      return result;
    } catch (e) {
      setIssue(
        e instanceof Error ? e.message : "Account action was not confirmed",
      );
      return null;
    } finally {
      setBusy(false);
    }
  };
  const account = data?.account;
  const running = data?.automation?.state === "running";
  return (
    <div className="settings-simple">
      {aiStatus}
      <section
        className="inner-card"
        id="automation"
        aria-labelledby="execution-title"
      >
        <div className="inner-card-title">
          <span id="execution-title">ACCOUNT & EXECUTION SECURITY</span>
          <span className="inner-tag">
            {account?.type.toUpperCase() || "NOT VERIFIED"}
          </span>
        </div>
        {account ? (
          <>
            <h2>{account.login}</h2>
            <p>{account.server}</p>
            <p className="inner-caption">
              Demo or Live is detected from authenticated MT5 account
              information.
            </p>
          </>
        ) : (
          <p>Connect your EA to verify your broker account.</p>
        )}
        <Link className="inner-text-link" href="/mt5">
          MT5 connection & broker verification →
        </Link>
        <div className="inner-kv">
          <span>Automatic broker execution</span>
          <b>
            {pollError ? "Unavailable" : running ? "Authorized" : "Disabled"}
          </b>
        </div>
        <p>
          Start Auto Trading on Home verifies OpenAI and authorizes one engine
          session for this exact account and EA. Demo and Live use the same
          engine and hard risk checks. A saved ON session can resume only after
          account and execution permissions are verified again. Stop and
          Emergency Stop stay OFF.
        </p>
        <Link className="inner-text-link" href="/">
          Auto Trading ON / OFF →
        </Link>
        {data?.connectionBlockers?.length || data?.blockers?.length ? (
          <details className="settings-inline-details">
            <summary>Account safety checks</summary>
            {[
              ...new Set([
                ...(data.connectionBlockers || []),
                ...(data.blockers || []),
              ]),
            ].map((item) => (
              <p key={item}>{item}</p>
            ))}
          </details>
        ) : null}
        {issue || pollError ? (
          <p className="inner-error" role="alert">
            {issue || pollError}
          </p>
        ) : null}
      </section>
      <section className="inner-card" id="risk-settings">
        <div className="inner-card-title">
          <span>STRATEGY & HARD RISK LIMITS</span>
          <span className="inner-tag">ALWAYS ENFORCED</span>
        </div>
        <p>
          OpenAI selects Scalping, Trend, Breakout, Reversal or WAIT from
          verified market conditions. It cannot raise the hard limits below.
        </p>
        {data?.settings ? (
          <details className="settings-inline-details">
            <summary>Lower your risk cap</summary>
            <form
              key={data.settingsRevision || "settings"}
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                await action({
                  action: "settings",
                  settings: {
                    ...data.settings,
                    strategy: "adaptive",
                    riskPerTradePct: Number(form.get("riskPerTradePct")),
                    maxAggregateRiskPct: Number(
                      form.get("maxAggregateRiskPct"),
                    ),
                    maxDailyLossPct: Number(form.get("maxDailyLossPct")),
                    maxDrawdownPct: Number(form.get("maxDrawdownPct")),
                  },
                });
              }}
            >
              <label className="trade-field">
                Maximum risk per trade (%)
                <input
                  name="riskPerTradePct"
                  type="number"
                  min="0.05"
                  max="0.25"
                  step="0.05"
                  required
                  inputMode="decimal"
                  defaultValue={Math.min(0.25, data.settings.riskPerTradePct)}
                />
              </label>
              {(
                [
                  [
                    "maxAggregateRiskPct",
                    "Maximum total open risk (%)",
                    0.05,
                    0.25,
                    0.05,
                  ],
                  ["maxDailyLossPct", "Maximum daily loss (%)", 0.1, 1, 0.1],
                  ["maxDrawdownPct", "Maximum drawdown (%)", 0.1, 5, 0.1],
                ] as const
              ).map(([name, label, min, max, step]) => (
                <label className="trade-field" key={name}>
                  {label}
                  <input
                    name={name}
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    required
                    inputMode="decimal"
                    defaultValue={Math.min(max, data.settings[name])}
                  />
                </label>
              ))}
              <button className="action-outline" disabled={busy || stopping}>
                Save lower risk cap
              </button>
            </form>
          </details>
        ) : (
          <p>Reading your existing risk configuration…</p>
        )}
        <div className="settings-risk-grid">
          <div>
            <strong>
              {data?.settings
                ? `${Math.min(0.25, data.settings.riskPerTradePct)}%`
                : "0.25%"}
            </strong>
            <span>Maximum trade risk</span>
          </div>
          <div>
            <strong>{Math.min(1, data?.settings.maxDailyLossPct ?? 1)}%</strong>
            <span>Daily loss limit</span>
          </div>
          <div>
            <strong>{Math.min(5, data?.settings.maxDrawdownPct ?? 5)}%</strong>
            <span>Drawdown limit</span>
          </div>
          <div>
            <strong>{Math.min(1, data?.settings.maxPositions ?? 1)}</strong>
            <span>Maximum positions</span>
          </div>
        </div>
        <p className="settings-small">
          {data?.settings.maxAggregateRiskPct ?? 0.25}% maximum aggregate open
          risk. Pause after 3 consecutive losses. Required stop-loss, broker
          volume and margin checks. No martingale, grid trading or averaging
          down. Stricter saved limits still apply. Changing strategy or risk
          pauses execution for review.
        </p>
      </section>
      <details className="inner-card" aria-labelledby="usage-title">
        <summary id="usage-title">OpenAI frequency & cost controls</summary>
        <div className="inner-card-title">
          <span>OPENAI FREQUENCY & COST CONTROL</span>
          <span className="inner-tag">SERVER ENFORCED</span>
        </div>
        {engine.data ? (
          <form
            key={`${engine.data.frequencySeconds}:${engine.data.usage?.dailyBudgetUsd}`}
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              await engine.action({
                action: "configure",
                frequencySeconds: Number(form.get("frequencySeconds")),
                dailyBudgetUsd: Number(form.get("dailyBudgetUsd")),
              });
            }}
          >
            <label className="trade-field">
              Minimum analysis interval
              <input
                name="frequencySeconds"
                type="number"
                min="60"
                max="3600"
                step="1"
                defaultValue={engine.data.frequencySeconds}
                required
                inputMode="numeric"
              />
            </label>
            <label className="trade-field">
              Daily app API budget (USD)
              <input
                name="dailyBudgetUsd"
                type="number"
                min="0.1"
                max="10"
                step="0.1"
                defaultValue={engine.data.usage?.dailyBudgetUsd ?? 1}
                inputMode="decimal"
                required
              />
            </label>
            <button className="action-outline" disabled={engine.busy}>
              Save AI usage limits
            </button>
          </form>
        ) : (
          <p>Checking server usage controls…</p>
        )}
        {engine.data?.usage ? (
          <>
            <div className="inner-kv">
              <span>Estimated API spend today</span>
              <b>${engine.data.usage.estimatedUsd.toFixed(4)}</b>
            </div>
            <div className="inner-kv">
              <span>Reserved for requests</span>
              <b>${engine.data.usage.reservedUsd.toFixed(4)}</b>
            </div>
            <p className="inner-caption">
              {engine.data.usage.inputTokens} input tokens ·{" "}
              {engine.data.usage.outputTokens} output tokens
            </p>
          </>
        ) : null}
        <p className="inner-caption">
          The app reserves estimated cost before requests and suspends analysis
          when its budget is unavailable. Provider bills may differ from
          estimates; provider alerts are not a guaranteed spending cap.
        </p>
        <div className="inner-kv">
          <span>Background service</span>
          <b>
            {engine.data?.scheduler?.configured
              ? engine.data.scheduler.mode
              : "Setup required"}
          </b>
        </div>
        {engine.error ? (
          <p className="inner-error" role="alert">
            {engine.error}
          </p>
        ) : null}
      </details>
      <section className="inner-card settings-emergency" id="emergency-stop">
        <div className="inner-card-title">
          <span>EMERGENCY STOP</span>
          <span className="inner-tag">IMMEDIATE CONTROL</span>
        </div>
        <p>
          Disable automated order submission independently of AI. Existing
          positions remain open. The engine session is revoked.
        </p>
        <button
          className="action-red"
          disabled={stopping}
          onClick={async () => {
            setStopping(true);
            setStopNotice("");
            try {
              await mt5Api("stop", {});
              await Promise.all([refresh(), engine.refresh()]);
              setStopNotice(
                "Emergency Stop confirmed. New automated orders are disabled; existing positions remain open.",
              );
            } catch (e) {
              setStopNotice(
                e instanceof Error
                  ? `Stop was not confirmed: ${e.message}`
                  : "Stop was not confirmed. Check MT5.",
              );
            } finally {
              setStopping(false);
            }
          }}
        >
          {stopping ? "Stopping…" : "EMERGENCY STOP"}
        </button>
        <p className="settings-small">
          An order already submitted to the broker may still fill.
        </p>
        {stopNotice ? (
          <p className="inner-notice" role="status">
            {stopNotice}
          </p>
        ) : null}
      </section>
      <details className="inner-card" id="execution-log">
        <summary>Execution & security activity</summary>
        {data?.activationEvents?.slice(0, 12).map((event, index) => (
          <div className="trade-history" key={`${event.createdAt}:${index}`}>
            <b>{event.event.replaceAll("_", " ")}</b>
            <p>{new Date(event.createdAt).toLocaleString()}</p>
          </div>
        ))}
        {data?.orders?.length ? (
          data.orders.slice(0, 12).map((order) => (
            <div className="trade-history" key={order.id}>
              <b>
                {order.order.kind || "OPEN"} {order.order.symbol} ·{" "}
                {order.status}
              </b>
              <p>
                {new Date(order.createdAt).toLocaleString()}
                {order.result
                  ? ` · Broker code ${order.result.retcode} · Deal ${order.result.deal}`
                  : " · Awaiting broker confirmation"}
              </p>
              {order.status === "uncertain" ? (
                <p>
                  Outcome unknown. Check MT5 history; no automatic replacement
                  is submitted.
                </p>
              ) : null}
            </div>
          ))
        ) : (
          <p>No broker order requests recorded.</p>
        )}
      </details>
      {children}
    </div>
  );
}
