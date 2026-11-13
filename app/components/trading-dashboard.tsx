"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import AppShell from "./app-shell";
import AnalysisPanel from "./analysis-panel";
import BrokerMarketTools from "./broker-chart";
import { mt5Api } from "../../lib/mt5-client";
import {
  monotonicEventTime,
  closeCommandFeedback,
  closeNeedsReconciliation,
  closeReviewFromResponse,
} from "../../lib/trading-feedback.mjs";
import {
  brokerNumber,
  brokerTime,
  useOrders,
  type OrderDashboard,
  type ManagedPosition,
} from "../../lib/use-orders";

export function ConnectedSymbols({
  data,
  error = "",
}: {
  data: OrderDashboard | null;
  error?: string;
}) {
  return (
    <section className="inner-card" aria-labelledby="ea-symbol-title">
      <div className="inner-card-title">
        <span id="ea-symbol-title">EA CONNECTED SYMBOL</span>
        <span className="inner-tag">
          {error ? "UNAVAILABLE" : data?.connection?.status || "CHECKING"}
        </span>
      </div>
      {data?.authorizedSymbols.length ? (
        data.authorizedSymbols.map((s) => (
          <div key={s.symbol} className="connected-symbol">
            <div className="order-heading">
              <h2>{s.symbol}</h2>
              <span className="settings-status">
                {!error && s.fresh && s.active
                  ? "Broker prices"
                  : "Waiting for fresh data"}
              </span>
            </div>
            <div className="balance-grid">
              <div>
                <span>Bid</span>
                <strong>{brokerNumber(s.bid)}</strong>
              </div>
              <div>
                <span>Ask</span>
                <strong>{brokerNumber(s.ask)}</strong>
              </div>
            </div>
            <p className="inner-caption">
              {data.account?.server} · {brokerTime(s.receivedAt)}
            </p>
          </div>
        ))
      ) : (
        <p>
          {data
            ? "Connect your Rocket1000 EA to see trading symbols and orders."
            : "Checking your authenticated EA connection…"}
        </p>
      )}
      {!data?.authorizedSymbols.length ? (
        <Link className="inner-text-link" href="/mt5">
          Connect MT5 →
        </Link>
      ) : null}
      {error ? (
        <p className="inner-error" role="alert">
          {error}. Displayed information may be outdated; new actions are
          blocked.
        </p>
      ) : null}
    </section>
  );
}

type CloseReview = {
  id: string;
  expiresAt: number;
  account: { login: string; server: string; type: "demo" | "live" };
  order: { kind: "CLOSE"; volume: number; symbol: string };
  receivedAt: number;
  validFor: number;
  accountKey: string;
  installationId: string;
  sessionId: string;
  ticket: string;
};
type CloseCommand = {
  id: string;
  status: string;
  ticket: string;
  accountKey: string;
  symbol: string;
  result?: unknown;
};
export function OpenOrders({
  data,
  error = "",
  refresh,
}: {
  data: OrderDashboard | null;
  error?: string;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<CloseReview | null>(null);
  const [issue, setIssue] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const [expired, setExpired] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [command, setCommand] = useState<CloseCommand | null>(null);
  const busyRequest = useRef(false);
  const version = useRef(0);
  const waitingForBroker = !!command && closeNeedsReconciliation(command);
  const commandId = command?.id;
  const commandAccount = command?.accountKey;
  const commandTicket = command?.ticket;
  const commandSymbol = command?.symbol;
  const reviewedPosition = data?.positions.find(
    (p) =>
      p.ticket === review?.ticket && p.account.login === review?.account.login,
  );
  const reviewAvailable =
    !!review &&
    review.accountKey === data?.accountKey &&
    !!data?.connection?.fresh &&
    !!data.permissionActive &&
    !!reviewedPosition?.canClose &&
    (!data.connection.installationId ||
      review.installationId === data.connection.installationId) &&
    (!data.connection.sessionId ||
      review.sessionId === data.connection.sessionId) &&
    !error;
  useEffect(() => {
    version.current += 1;
    if (review && !reviewAvailable) dialog.current?.close();
  }, [
    data?.accountKey,
    data?.connection?.fresh,
    error,
    review,
    reviewAvailable,
  ]);
  useEffect(() => {
    if (!review) {
      dialog.current?.close();
      return;
    }
    dialog.current?.showModal();
    const timer = window.setInterval(
      () =>
        setExpired(performance.now() - review.receivedAt >= review.validFor),
      250,
    );
    return () => window.clearInterval(timer);
  }, [review]);
  useEffect(() => {
    if (
      !commandId ||
      !commandTicket ||
      !waitingForBroker ||
      commandAccount !== data?.accountKey
    )
      return;
    let active = true;
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        const current = await (
          await mt5Api(`trading?commandId=${encodeURIComponent(commandId!)}`)
        ).json();
        if (!active) return;
        if (
          current.id !== commandId ||
          current.accountKey !== commandAccount ||
          current.kind !== "CLOSE" ||
          current.position !== commandTicket ||
          current.symbol !== commandSymbol
        )
          throw new Error(
            "The close request belongs to a different MT5 connection.",
          );
        setIssue(closeCommandFeedback(current));
        setCommand({ ...current, ticket: commandTicket });
        await refresh();
      } catch (e) {
        if (active)
          setIssue(
            `Close status is not verified: ${e instanceof Error ? e.message : "connection unavailable"}. Do not submit a replacement while its broker outcome is unknown.`,
          );
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    commandId,
    commandAccount,
    commandTicket,
    commandSymbol,
    data?.accountKey,
    refresh,
    waitingForBroker,
  ]);
  useEffect(() => {
    const stopped = () => {
      version.current += 1;
      dialog.current?.close();
      setReview(null);
    };
    window.addEventListener("rocket-trading-stopped", stopped);
    return () => {
      version.current += 1;
      window.removeEventListener("rocket-trading-stopped", stopped);
    };
  }, []);
  async function prepare(p: ManagedPosition) {
    if (
      busyRequest.current ||
      !p.canClose ||
      error ||
      !data ||
      waitingForBroker
    )
      return;
    if (review && unconfirmed) {
      dialog.current?.showModal();
      setIssue(
        "Resolve the original close request before reviewing a replacement.",
      );
      return;
    }
    busyRequest.current = true;
    const generation = version.current;
    const started = monotonicEventTime();
    setBusy(true);
    setIssue("");
    try {
      const result = await (
        await mt5Api("trading", {
          action: "preview",
          expectedAccountKey: data.accountKey,
          expectedInstallationId: data.connection?.installationId,
          expectedSessionId: data.connection?.sessionId,
          order: { kind: "CLOSE", position: p.ticket },
        })
      ).json();
      if (generation !== version.current) return;
      const next = closeReviewFromResponse(result, {
        account: data.account,
        accountKey: data.accountKey,
        position: p,
        serverTime: data.serverTime,
        started,
      });
      if (monotonicEventTime() - started >= next.validFor)
        throw new Error("This close review expired. Refresh and review again.");
      setExpired(false);
      setUnconfirmed(false);
      setReview(next);
    } catch (e) {
      setIssue(e instanceof Error ? e.message : "Close could not be reviewed");
    } finally {
      busyRequest.current = false;
      setBusy(false);
    }
  }
  const positions = data?.positions || [];
  return (
    <section className="inner-card" aria-labelledby="open-orders-title">
      <div className="inner-card-title">
        <span id="open-orders-title">OPEN ORDERS</span>
        <span className="inner-tag">{data ? positions.length : "—"}</span>
      </div>
      {positions.length ? (
        positions.map((p) => (
          <article
            className="order-position"
            key={`${p.account.server}:${p.account.login}:${p.ticket}`}
          >
            <div className="order-heading">
              <h3>{p.symbol}</h3>
              <span
                className={`order-side ${p.side === "BUY" ? "is-buy" : "is-sell"}`}
              >
                {p.side}
              </span>
            </div>
            <p className="order-ticket">
              Position #{p.ticket} · {brokerNumber(p.volume, 8)} lots
            </p>
            <div className="order-values">
              <div>
                <span>Entry</span>
                <strong>{brokerNumber(p.open)}</strong>
              </div>
              <div>
                <span>Broker price</span>
                <strong>{brokerNumber(p.currentPrice)}</strong>
              </div>
              <div>
                <span>Floating P/L</span>
                <strong
                  className={
                    p.profit < 0
                      ? "value-loss"
                      : p.profit > 0
                        ? "value-profit"
                        : ""
                  }
                >
                  {brokerNumber(p.profit, 2)}{" "}
                  {p.account.currency ||
                    (p.account.login === data?.account?.login &&
                    p.account.server === data?.account?.server
                      ? data.account.currency
                      : "")}
                </strong>
              </div>
              <div>
                <span>Status</span>
                <strong>
                  {error || !p.fresh ? "Requires attention" : p.status}
                </strong>
              </div>
              <div>
                <span>Stop-loss</span>
                <strong>{p.stop ? brokerNumber(p.stop) : "Missing"}</strong>
              </div>
              <div>
                <span>Take-profit</span>
                <strong>
                  {p.takeProfit ? brokerNumber(p.takeProfit) : "Not set"}
                </strong>
              </div>
            </div>
            <p className="inner-caption">
              Opened {brokerTime(p.openedAt)} · Account {p.account.login}
            </p>
            {!p.fresh || p.status === "Requires attention" ? (
              <p className="order-attention">
                Broker position retained for reconciliation. Reconnect its
                authorized account and symbol before management.
              </p>
            ) : null}
            <button
              type="button"
              className="action-outline"
              disabled={busy || waitingForBroker || !!error || !p.canClose}
              title={
                error ||
                p.closeBlocker ||
                (waitingForBroker
                  ? "Waiting for the existing broker command to finish."
                  : undefined)
              }
              onClick={() => void prepare(p)}
            >
              Close Position
            </button>
          </article>
        ))
      ) : (
        <p>
          {data
            ? "No broker-confirmed Rocket1000 positions."
            : "Waiting for verified broker positions…"}
        </p>
      )}
      <p className="inner-caption">
        Only verified Rocket1000-owned positions appear here. External trades
        are excluded.
        {positions.some((p) => !p.canClose)
          ? ` Closing is unavailable: ${error || positions.find((p) => !p.canClose)?.closeBlocker || "current account authorization and fresh broker position data are required."}`
          : ""}
      </p>
      {issue ? (
        <p className="inner-notice" role="status">
          {issue}
        </p>
      ) : null}
      <dialog
        className="live-activation-dialog"
        ref={dialog}
        onCancel={() => {
          if (!unconfirmed) setReview(null);
        }}
        onClose={() => {
          if (!unconfirmed || review?.accountKey !== data?.accountKey)
            setReview(null);
        }}
        aria-labelledby="close-review-title"
      >
        <button
          className="action-outline"
          type="button"
          onClick={() => {
            if (unconfirmed) dialog.current?.close();
            else setReview(null);
          }}
          disabled={busy}
          autoFocus
        >
          Cancel
        </button>
        <h2 id="close-review-title">Confirm position close</h2>
        {review ? (
          <>
            <p>
              <strong>
                {review.account.type.toUpperCase()} account{" "}
                {review.account.login}
              </strong>
              <br />
              {review.account.server}
            </p>
            <p>
              Close {brokerNumber(review.order.volume, 8)} lots of{" "}
              {review.order.symbol}, ticket #{review.ticket}, at the actual
              broker market price?
            </p>
            <p className="inner-caption">
              Slippage may change the final price. The position stays displayed
              until MT5 confirms its outcome.
            </p>
            <button
              type="button"
              className="action-red"
              disabled={busy || (expired && !unconfirmed) || !reviewAvailable}
              onClick={async () => {
                if (busyRequest.current || !reviewAvailable) return;
                if (
                  !unconfirmed &&
                  performance.now() - review.receivedAt >= review.validFor
                ) {
                  setExpired(true);
                  return;
                }
                busyRequest.current = true;
                const generation = version.current;
                setBusy(true);
                try {
                  const result = await (
                    await mt5Api("trading", {
                      action: "confirm",
                      previewId: review.id,
                      expectedAccountKey: review.accountKey,
                      expectedInstallationId: review.installationId,
                      expectedSessionId: review.sessionId,
                    })
                  ).json();
                  if (generation !== version.current) {
                    await refresh();
                    return;
                  }
                  const feedback = closeCommandFeedback(result);
                  setCommand({
                    ...result,
                    ticket: review.ticket,
                    accountKey: review.accountKey,
                    symbol: review.order.symbol,
                  });
                  setUnconfirmed(false);
                  setReview(null);
                  setIssue(feedback);
                  await refresh();
                } catch (e) {
                  const status = (e as Error & { status?: number }).status;
                  const unknown = !status || status >= 500;
                  setUnconfirmed(unknown);
                  setIssue(
                    unknown
                      ? "Close submission was not confirmed. Retry this same confirmation to check the original request; do not create a replacement."
                      : e instanceof Error
                        ? e.message
                        : "Close was not confirmed",
                  );
                  if (!unknown) setReview(null);
                } finally {
                  busyRequest.current = false;
                  setBusy(false);
                }
              }}
            >
              {busy
                ? "Submitting…"
                : unconfirmed
                  ? "Check original close request"
                  : expired
                    ? "Review expired"
                    : `Confirm ${review.account.type.toUpperCase()} close`}
            </button>
          </>
        ) : null}
      </dialog>
    </section>
  );
}

export function UpcomingOrders({
  data,
  error = "",
}: {
  data: OrderDashboard | null;
  error?: string;
}) {
  return (
    <section className="inner-card" aria-labelledby="upcoming-title">
      <div className="inner-card-title">
        <span id="upcoming-title">UPCOMING ORDERS</span>
        <span className="inner-tag">PROPOSALS</span>
      </div>
      {!error && data?.opportunities.length ? (
        data.opportunities.map((o) => (
          <article className="order-opportunity" key={o.id}>
            <div className="order-heading">
              <h3>
                {o.symbol} · {o.decision}
              </h3>
              <span className="inner-tag">{o.status}</span>
            </div>
            <p className="order-ticket">AI proposal · {o.strategy}</p>
            <p>{o.reasoning}</p>
            <div className="order-values">
              <div>
                <span>Proposed entry</span>
                <strong>{brokerNumber(o.entryPrice)}</strong>
              </div>
              <div>
                <span>Reward / risk</span>
                <strong>
                  {o.entryPrice !== null &&
                  o.stopLoss !== null &&
                  o.takeProfit !== null &&
                  Math.abs(o.entryPrice - o.stopLoss) > 0
                    ? `${brokerNumber(Math.abs(o.takeProfit - o.entryPrice) / Math.abs(o.entryPrice - o.stopLoss), 2)} : 1`
                    : "Not available"}
                </strong>
              </div>
              <div>
                <span>Proposed SL</span>
                <strong>{brokerNumber(o.stopLoss)}</strong>
              </div>
              <div>
                <span>Proposed TP</span>
                <strong>{brokerNumber(o.takeProfit)}</strong>
              </div>
            </div>
            <p className="inner-caption">Signal {brokerTime(o.analyzedAt)}</p>
          </article>
        ))
      ) : (
        <p>
          {data
            ? "No confirmed trading setup right now."
            : "Checking verified trading opportunities…"}
        </p>
      )}
      {data?.brokerPending.length ? (
        <div className="broker-pending">
          <h3>Broker-pending orders</h3>
          {error ? (
            <p>
              Connection unavailable. Last reported pending orders require
              broker reconciliation.
            </p>
          ) : null}
          {data.brokerPending.map((o) => (
            <div key={o.ticket} className="trade-history">
              <b>
                {o.symbol} · {o.side} · {o.status}
              </b>
              <p>
                #{o.ticket} · {brokerNumber(o.volume, 8)} lots · Entry{" "}
                {brokerNumber(o.price)}
              </p>
              <p className="inner-caption">
                SL {brokerNumber(o.stop)} · TP {brokerNumber(o.takeProfit)} ·{" "}
                {brokerTime(o.createdAt)}
              </p>
            </div>
          ))}
        </div>
      ) : null}
      <p className="inner-caption">
        A proposal is not a broker order or a guaranteed trade. Paused AI cannot
        execute it.
      </p>
    </section>
  );
}

export function BrokerHistory({ data }: { data: OrderDashboard | null }) {
  return (
    <details className="inner-card compact-history">
      <summary>
        Broker-confirmed trade history{" "}
        <span>{data?.history.length ?? "—"}</span>
      </summary>
      {data?.history.length ? (
        data.history.slice(0, 20).map((d) => (
          <div className="trade-history" key={d.ticket}>
            <b>
              {d.symbol} · {d.side} · {d.entry}
            </b>
            <p>
              Deal #{d.ticket} · {brokerNumber(d.volume, 8)} lots at{" "}
              {brokerNumber(d.price)}
            </p>
            <p>
              P/L {brokerNumber(d.profit, 2)} · Fee{" "}
              {brokerNumber(
                (d.commission || 0) + (d.swap || 0) + (d.fee || 0),
                2,
              )}
            </p>
            <small>
              {brokerTime(d.time)} · {d.reason}
            </small>
          </div>
        ))
      ) : (
        <p>No verified Rocket1000 deal history reported yet.</p>
      )}
    </details>
  );
}

export default function TradingDashboard() {
  const { data, error, refresh } = useOrders();
  return (
    <AppShell
      title="Market"
      subtitle="Your EA. Your orders. Verified by MT5."
      active="Markets"
    >
      <ConnectedSymbols data={data} error={error} />
      <BrokerMarketTools />
      <OpenOrders data={data} error={error} refresh={refresh} />
      <UpcomingOrders data={data} error={error} />
      <AnalysisPanel />
      <BrokerHistory data={data} />
    </AppShell>
  );
}
