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
import LiveActivation from "./live-activation";

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
  const [confirmation, setConfirmation] = useState("");
  const [reviewAccountKey, setReviewAccountKey] = useState("");
  const demoDialog = useRef<HTMLDialogElement>(null);
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
  useEffect(() => {
    if (
      reviewAccountKey &&
      (reviewAccountKey !== data?.accountKey || pollError)
    )
      demoDialog.current?.close();
  }, [data?.accountKey, pollError, reviewAccountKey]);
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
  const blocked =
    !!pollError ||
    !account ||
    !data?.market ||
    !!data.connectionBlockers?.length;
  const phrase = account
    ? `ENABLE ${account.type.toUpperCase()} ${account.login}`
    : "";
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
          START AI runs analysis. These separate controls authorize genuine
          broker orders for this account only.
        </p>
        {running ? (
          <button
            className="action-outline"
            disabled={busy || stopping}
            onClick={() =>
              void action({
                action: "pause-auto",
                accountKey: data?.accountKey,
              })
            }
          >
            Disable automatic execution
          </button>
        ) : account?.type === "demo" ? (
          <button
            className="action-outline"
            disabled={busy || stopping || blocked}
            onClick={() => {
              setConfirmation("");
              setIssue("");
              setReviewAccountKey(data?.accountKey || "");
              demoDialog.current?.showModal();
            }}
          >
            Authorize Demo execution
          </button>
        ) : null}
        <LiveActivation
          key={`${data?.accountKey}:${data?.sessionId}:${data?.installationId}:${data?.settingsRevision}`}
          data={data}
          busy={busy || stopping}
          action={action}
          serverError={issue}
        />
        {!running && account?.type === "live" && data?.liveConfirmed ? (
          <button
            className="action-red"
            disabled={
              busy || stopping || blocked || !data.demoValidation?.passed
            }
            onClick={() =>
              void action({ action: "start-auto", accountKey: data.accountKey })
            }
          >
            Enable authorized Live execution
          </button>
        ) : null}
        {account && data?.positions?.length ? (
          <details
            className="settings-inline-details"
            key={`reviewed:${data.accountKey}:${data.sessionId}`}
          >
            <summary>Reviewed position-close permission</summary>
            <p>
              Account {account.login} · {account.server} ·{" "}
              {account.type.toUpperCase()}.
            </p>
            <p>
              This permits separately reviewed, user-confirmed full closes in
              Market. It does not start AI or automatic trading, and does not
              close any position by itself.
            </p>
            {data.enabled ? (
              <>
                <p className="inner-caption">
                  Reviewed permission{" "}
                  {data.expiresAt
                    ? `expires ${new Date(data.expiresAt).toLocaleTimeString()}`
                    : "is enabled for this verified EA session"}
                  .
                </p>
                <button
                  className="action-outline"
                  disabled={busy || stopping}
                  onClick={() => void action({ action: "disable" })}
                >
                  Disable reviewed permission
                </button>
              </>
            ) : (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  const typed = String(
                    new FormData(event.currentTarget).get(
                      "accountConfirmation",
                    ) || "",
                  );
                  if (typed !== phrase) {
                    setIssue(`Type ${phrase} exactly to confirm this account.`);
                    return;
                  }
                  await action({
                    action: "enable",
                    accountKey: data.accountKey,
                    confirmation: typed,
                  });
                }}
              >
                <label className="trade-field">
                  Type {phrase}
                  <input
                    name="accountConfirmation"
                    autoComplete="off"
                    required
                  />
                </label>
                <button
                  className="action-outline"
                  disabled={
                    busy || stopping || blocked || !!data.blockers?.length
                  }
                >
                  Enable reviewed closes for 15 minutes
                </button>
              </form>
            )}
            <p className="inner-caption">
              Live account approval and current-engine Demo validation still
              apply. If a safety check blocks management here, review or close
              the position directly in MT5.
            </p>
            <Link className="inner-text-link" href="/dashboard">
              Review open positions →
            </Link>
          </details>
        ) : null}
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
        {data?.settings ? (
          <form
            key={data.settingsRevision || "settings"}
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              await action({
                action: "settings",
                settings: {
                  ...data.settings,
                  strategy: form.get("strategy"),
                  riskPerTradePct: Number(form.get("riskPerTradePct")),
                },
              });
            }}
          >
            <label className="trade-field">
              AI strategy
              <select name="strategy" defaultValue={data.settings.strategy}>
                <option value="adaptive">Adaptive AI</option>
                <option value="price-action">Price Action</option>
                <option value="scalping">Scalping</option>
              </select>
            </label>
            <label className="trade-field">
              Maximum risk per trade (%)
              <input
                name="riskPerTradePct"
                type="number"
                min="0.1"
                max="0.5"
                step="0.1"
                required
                inputMode="decimal"
                defaultValue={Math.min(0.5, data.settings.riskPerTradePct)}
              />
            </label>
            <button className="action-outline" disabled={busy || stopping}>
              Save risk & strategy
            </button>
          </form>
        ) : (
          <p>Reading your existing risk configuration…</p>
        )}
        <div className="settings-risk-grid">
          <div>
            <strong>
              {data?.settings
                ? `${Math.min(0.5, data.settings.riskPerTradePct)}%`
                : "0.5%"}
            </strong>
            <span>Maximum trade risk</span>
          </div>
          <div>
            <strong>{Math.min(5, data?.settings.maxDailyLossPct ?? 5)}%</strong>
            <span>Daily loss limit</span>
          </div>
          <div>
            <strong>{Math.min(5, data?.settings.maxDrawdownPct ?? 5)}%</strong>
            <span>Drawdown limit</span>
          </div>
          <div>
            <strong>{Math.min(3, data?.settings.maxPositions ?? 3)}</strong>
            <span>Maximum positions</span>
          </div>
        </div>
        <p className="settings-small">
          3% aggregate open risk maximum. Required stop-loss, broker volume and
          margin checks. No martingale or averaging down. Stricter saved limits
          still apply. Changing strategy or risk pauses execution for review.
        </p>
      </section>
      <section className="inner-card" aria-labelledby="usage-title">
        <div className="inner-card-title">
          <span id="usage-title">AI FREQUENCY & COST CONTROL</span>
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
      </section>
      <section className="inner-card settings-emergency" id="emergency-stop">
        <div className="inner-card-title">
          <span>EMERGENCY STOP</span>
          <span className="inner-tag">IMMEDIATE CONTROL</span>
        </div>
        <p>
          Disable automated order submission independently of AI. Existing
          positions remain open. Live approval is revoked.
        </p>
        <button
          className="action-red"
          disabled={stopping}
          onClick={async () => {
            setStopping(true);
            setStopNotice("");
            try {
              await mt5Api("stop", {});
              await refresh();
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
      <dialog
        className="live-activation-dialog"
        ref={demoDialog}
        aria-labelledby="demo-execution-title"
        onClose={() => {
          setConfirmation("");
          setReviewAccountKey("");
        }}
      >
        <button
          className="action-outline"
          autoFocus
          onClick={() => demoDialog.current?.close()}
        >
          Cancel
        </button>
        <h2 id="demo-execution-title">Authorize Demo broker execution</h2>
        <p>
          Account <strong>{account?.login}</strong> · {account?.server}
          <br />
          Automatically detected <strong>{account?.type.toUpperCase()}</strong>.
        </p>
        <p>
          This permits genuine Demo broker orders from validated AI proposals
          within your risk limits. START AI remains a separate analysis control.
        </p>
        <label className="trade-field">
          Type {phrase}
          <input
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        {issue ? (
          <p className="inner-error" role="alert">
            {issue}
          </p>
        ) : null}
        <button
          className="action-red"
          disabled={
            busy ||
            stopping ||
            blocked ||
            account?.type !== "demo" ||
            reviewAccountKey !== data?.accountKey ||
            confirmation !== phrase
          }
          onClick={async () => {
            const result = await action({
              action: "start-auto",
              accountKey: data?.accountKey,
              confirmation,
            });
            if (result) demoDialog.current?.close();
          }}
        >
          Confirm Demo execution for {account?.login}
        </button>
      </dialog>
    </div>
  );
}
