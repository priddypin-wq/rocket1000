"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { mt5Api } from "../../lib/mt5-client";
import { useAnalysisEngine, engineLabel } from "../../lib/use-analysis-engine";
import { useOrders, brokerNumber, brokerTime } from "../../lib/use-orders";
import type { AutoState } from "../../lib/trading-types";
import OpenAiConnection from "./openai-connection";
import { liveReviewMatches } from "../../lib/live-review.mjs";
import { engineIdentityMatches } from "../../lib/engine-control-client.mjs";

type Diagnostics = AutoState & {
  blockers: string[];
  orders: {
    id: string;
    status: string;
    createdAt: number;
    order: { kind?: string; symbol: string };
    result?: { retcode?: number; deal?: string } | null;
  }[];
};
type LiveReview = {
  id: string;
  account: { login: string; server: string; type: string };
  accountKey: string;
  engineVersion: string;
  expiresAt: number;
  installationId: string;
  sessionId: string;
  settingsRevision: string;
};

export default function EngineDiagnostics() {
  const engine = useAnalysisEngine();
  const orders = useOrders();
  const [data, setData] = useState<Diagnostics | null>(null);
  const [events, setEvents] = useState<{ event: string; createdAt: number }[]>(
    [],
  );
  const [error, setError] = useState("");
  const [authorizationError, setAuthorizationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<LiveReview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);
  const mounted = useRef(false);
  const mutating = useRef(false);
  const requestRevision = useRef(0);
  const refresh = useCallback(async () => {
    const [trade, audit] = await Promise.all([
      mt5Api("trading").then((r) => r.json()),
      mt5Api("logs").then((r) => r.json()),
    ]);
    return {
      trade: trade as Diagnostics,
      events: audit.logs as { event: string; createdAt: number }[],
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    let pending = false,
      alive = true;
    async function poll() {
      if (pending || mutating.current) return;
      pending = true;
      const revision = requestRevision.current;
      try {
        const next = await refresh();
        if (alive && mounted.current && revision === requestRevision.current) {
          setData(next.trade);
          setEvents(next.events);
          setError("");
        }
      } catch (e) {
        if (alive && mounted.current && revision === requestRevision.current)
          setError(e instanceof Error ? e.message : "Diagnostics unavailable");
      } finally {
        pending = false;
        if (
          alive &&
          mounted.current &&
          revision !== requestRevision.current &&
          !mutating.current
        )
          void poll();
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const stopped = () => {
      requestRevision.current += 1;
      setData(null);
      setReview(null);
      setAccepted(false);
      setNotice("");
      setAuthorizationError("");
      void poll();
    };
    window.addEventListener("rocket-trading-stopped", stopped);
    return () => {
      alive = false;
      mounted.current = false;
      requestRevision.current += 1;
      window.clearInterval(timer);
      window.clearInterval(clock);
      window.removeEventListener("rocket-trading-stopped", stopped);
    };
  }, [refresh]);
  const reviewValid = liveReviewMatches(
    review,
    data,
    orders.data,
    now,
    !!error || !!orders.error,
  );
  async function authorize(confirm: boolean) {
    if (mutating.current) return;
    mutating.current = true;
    const revision = ++requestRevision.current;
    setBusy(true);
    setNotice("");
    setAuthorizationError("");
    try {
      if (
        confirm &&
        (!liveReviewMatches(
          review,
          data,
          orders.data,
          Date.now(),
          !!error || !!orders.error,
        ) ||
          !accepted ||
          !review)
      )
        throw Error(
          "Review this current Live account again before confirming.",
        );
      const result = await (
        await mt5Api(
          "trading",
          confirm
            ? {
                action: "confirm-live",
                id: review!.id,
                accountKey: review!.accountKey,
              }
            : {
                action: "prepare-live",
                expectedAccountKey: data?.accountKey,
                expectedInstallationId: data?.installationId,
                expectedSessionId: data?.sessionId,
              },
          AbortSignal.timeout(15000),
        )
      ).json();
      if (!mounted.current || revision !== requestRevision.current) return;
      if (confirm) {
        if (
          result?.ok !== true ||
          result.liveConfirmed !== true ||
          result.accountKey !== review?.accountKey ||
          result.executionEnabled !== false
        )
          throw Error("The server did not confirm this account approval.");
        setReview(null);
        setAccepted(false);
        setNotice(
          "Account approval saved. Auto Trading remains OFF until explicitly enabled.",
        );
      } else {
        if (
          !result?.id ||
          result.account?.type !== "live" ||
          result.accountKey !== data?.accountKey ||
          !data?.installationId ||
          !data.sessionId ||
          result.installationId !== data.installationId ||
          result.sessionId !== data.sessionId ||
          result.settingsRevision !== data.settingsRevision
        )
          throw Error(
            "The connected account changed. Review the current Live account again.",
          );
        setReview(result);
        setAccepted(false);
        setNow(Date.now());
      }
      const next = await refresh();
      if (!mounted.current || revision !== requestRevision.current) return;
      setData(next.trade);
      setEvents(next.events);
      await Promise.all([orders.refresh(), engine.refresh()]);
    } catch (e) {
      if (mounted.current && revision === requestRevision.current)
        setAuthorizationError(
          e instanceof Error && e.name === "TimeoutError"
            ? "Account authorization timed out. Check the current approval status before retrying. This action did not start Auto Trading."
            : e instanceof Error
              ? e.message
              : "Account authorization failed",
        );
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="engine-diagnostics">
      <OpenAiConnection />
      <details className="inner-card" open>
        <summary>Engine health & scheduling</summary>
        <div className="inner-kv">
          <span>Analysis engine</span>
          <b>
            {engine.error ? "Unavailable" : engineLabel(engine.data?.state)}
          </b>
        </div>
        <div className="inner-kv">
          <span>Execution mode</span>
          <b>
            {engine.error ||
            !engine.data ||
            (engine.data.executionAuthorized &&
              (!engineIdentityMatches(engine.data, orders.data) ||
                orders.error))
              ? "Unavailable"
              : engine.data.executionAuthorized &&
                  engineIdentityMatches(engine.data, orders.data) &&
                  !orders.error
                ? "Authorized"
                : "Analysis only / execution OFF"}
          </b>
        </div>
        <p>{engine.data?.reason || "Waiting for verified engine status."}</p>
        <div className="inner-kv">
          <span>Background service</span>
          <b>
            {engine.data?.scheduler?.configured
              ? engine.data.scheduler.mode
              : "Not verified"}
          </b>
        </div>
        <div className="inner-kv">
          <span>Last cycle</span>
          <b>{brokerTime(engine.data?.lastCycle)}</b>
        </div>
        {engine.data?.scheduler?.configured && engine.data?.nextCycle ? (
          <div className="inner-kv">
            <span>Scheduled cycle</span>
            <b>{brokerTime(engine.data.nextCycle)}</b>
          </div>
        ) : null}
        {engine.data?.automaticAnalysis?.reason ? (
          <p>{engine.data.automaticAnalysis.reason}</p>
        ) : null}
      </details>
      <details className="inner-card">
        <summary>API spending & frequency limits</summary>
        <div className="inner-kv">
          <span>Analysis frequency floor</span>
          <b>
            {engine.data
              ? engine.data.frequencySeconds + " seconds"
              : "Checking"}
          </b>
        </div>
        {engine.data?.usage ? (
          <>
            <div className="inner-kv">
              <span>Daily backend budget</span>
              <b>${engine.data.usage.dailyBudgetUsd.toFixed(2)}</b>
            </div>
            <div className="inner-kv">
              <span>Estimated / reserved</span>
              <b>
                ${engine.data.usage.estimatedUsd.toFixed(4)} / $
                {engine.data.usage.reservedUsd.toFixed(4)}
              </b>
            </div>
            <div className="inner-kv">
              <span>Input / output tokens</span>
              <b>
                {engine.data.usage.inputTokens} /{" "}
                {engine.data.usage.outputTokens}
              </b>
            </div>
          </>
        ) : (
          <p>Usage status unavailable.</p>
        )}
        <p className="inner-caption">
          Server budget reservations and rate limits remain enforced.
          Configuration is managed by the operator.
        </p>
      </details>
      <details className="inner-card">
        <summary>Broker & risk engine diagnostics</summary>
        <div className="inner-kv">
          <span>Connection</span>
          <b>
            {orders.error
              ? "Unavailable"
              : orders.data?.connection?.status || "Checking"}
          </b>
        </div>
        <div className="inner-kv">
          <span>Last heartbeat</span>
          <b>{brokerTime(orders.data?.connection?.lastHeartbeat)}</b>
        </div>
        <div className="inner-kv">
          <span>Free margin</span>
          <b>{brokerNumber(orders.data?.account?.freeMargin, 2)}</b>
        </div>
        <div className="inner-kv">
          <span>Daily loss / drawdown</span>
          <b>
            {brokerNumber(data?.risk?.dailyLoss, 2)} /{" "}
            {brokerNumber(data?.risk?.drawdownPct, 2)}%
          </b>
        </div>
        {data?.settings ? (
          <>
            <div className="inner-kv">
              <span>Per-trade / aggregate ceilings</span>
              <b>
                {data.settings.riskPerTradePct}% /{" "}
                {data.settings.maxAggregateRiskPct}%
              </b>
            </div>
            <div className="inner-kv">
              <span>Daily loss / drawdown ceilings</span>
              <b>
                {data.settings.maxDailyLossPct}% /{" "}
                {data.settings.maxDrawdownPct}%
              </b>
            </div>
            <div className="inner-kv">
              <span>Position ceiling</span>
              <b>{data.settings.maxPositions}</b>
            </div>
          </>
        ) : null}
        {[
          ...new Set([
            ...(data?.connectionBlockers || []),
            ...(data?.blockers || []),
          ]),
        ].map((item) => (
          <p key={item}>{item}</p>
        ))}
      </details>
      <details className="inner-card" open>
        <summary>Trading authorization & verification</summary>
        <p>
          {data?.account
            ? data.account.login +
              " · " +
              data.account.server +
              " · " +
              data.account.type.toUpperCase()
            : "No verified broker account."}
        </p>
        <div className="inner-kv">
          <span>Current execution permission</span>
          <b>
            {error ||
            orders.error ||
            !data ||
            data.accountKey !== orders.data?.accountKey ||
            data.installationId !== orders.data?.connection?.installationId ||
            data.sessionId !== orders.data?.connection?.sessionId
              ? "Unavailable"
              : data?.permissionActive
                ? "Authorized"
                : "OFF"}
          </b>
        </div>
        {data?.account?.type === "live" ? (
          <>
            <div className="inner-kv">
              <span>Exact Live account approval</span>
              <b>{data.liveConfirmed ? "Verified" : "Required"}</b>
            </div>
            {!data.liveConfirmed && !review ? (
              <button
                type="button"
                className="action-outline"
                disabled={busy || !!error || !!orders.error}
                onClick={() => void authorize(false)}
              >
                {busy ? "Checking Live account…" : "Review this Live account"}
              </button>
            ) : null}
          </>
        ) : (
          <p>
            Demo execution requires explicit Enable Auto Trading and all broker
            and risk checks.
          </p>
        )}
        {data?.account?.type === "live" && data.connectionBlockers?.length ? (
          <div role="status">
            <p>Live review is blocked by the current terminal status:</p>
            {data.connectionBlockers.map((blocker) => (
              <p key={blocker}>{blocker}</p>
            ))}
          </div>
        ) : null}
        {authorizationError ? (
          <p className="inner-error" role="alert">
            {authorizationError}
          </p>
        ) : null}
        {review ? (
          <div
            className="live-review"
            role="group"
            aria-labelledby="drawer-live-title"
          >
            <h3 id="drawer-live-title">Authorize this Live account?</h3>
            <p>
              <strong>{review.account.login}</strong>
              <br />
              {review.account.server}
              <br />
              {review.account.type.toUpperCase()} · Engine{" "}
              {review.engineVersion}
            </p>
            <p>
              This approval applies only to the displayed account and engine.
              Saving approval does not start execution.
            </p>
            <label>
              <input
                type="checkbox"
                disabled={busy || !reviewValid}
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />{" "}
              I authorize automatic real-money trading for this account when I
              explicitly enable it.
            </label>
            {!reviewValid ? (
              <p className="inner-error">
                Account changed, data unavailable or review expired. Cancel and
                review again.
              </p>
            ) : null}
            <div className="engine-actions">
              <button
                type="button"
                className="action-outline"
                disabled={busy}
                onClick={() => {
                  setReview(null);
                  setAccepted(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action-red"
                disabled={busy || !accepted || !reviewValid}
                onClick={() => void authorize(true)}
              >
                {busy ? "Saving account approval…" : "Confirm account approval"}
              </button>
            </div>
          </div>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
      </details>
      <details className="inner-card">
        <summary>Execution & error logs</summary>
        {data?.orders?.length ? (
          data.orders.map((order) => (
            <div className="trade-history" key={order.id}>
              <b>
                {order.order.symbol} · {order.order.kind || "Command"} ·{" "}
                {order.status}
              </b>
              <p>
                {order.result?.retcode
                  ? "Broker return code " + order.result.retcode
                  : "No confirmed broker result"}
              </p>
              <small>{brokerTime(order.createdAt)}</small>
            </div>
          ))
        ) : (
          <p>No recorded execution commands.</p>
        )}
        {events?.length ? (
          events.slice(0, 15).map((event, index) => (
            <p className="inner-caption" key={event.createdAt + ":" + index}>
              {event.event.replaceAll("_", " ")} · {brokerTime(event.createdAt)}
            </p>
          ))
        ) : (
          <p>No recorded connection events.</p>
        )}
      </details>
      {error || engine.error || orders.error ? (
        <p className="inner-error" role="alert">
          {error || engine.error || orders.error}
        </p>
      ) : null}
    </div>
  );
}
