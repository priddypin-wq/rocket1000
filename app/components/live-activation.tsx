"use client";
import { useEffect, useRef, useState } from "react";
import type { AutoState, TradeSettings } from "../../lib/trading-types";

type Account = NonNullable<AutoState["account"]>;
type Approval = {
  approvalId: string;
  expiresAt: number;
  serverTime: number;
  accountKey: string;
  account: Account;
  settings: TradeSettings;
  currentRiskPct: number;
};
type Action = (value: unknown) => Promise<unknown>;
function isApproval(value: unknown): value is Approval {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<Approval>;
  return (
    typeof result.approvalId === "string" &&
    !!result.approvalId &&
    typeof result.expiresAt === "number" &&
    typeof result.serverTime === "number" &&
    Number.isFinite(result.expiresAt) &&
    Number.isFinite(result.serverTime) &&
    result.serverTime > 0 &&
    result.expiresAt > result.serverTime &&
    result.expiresAt - result.serverTime <= 60000 &&
    typeof result.accountKey === "string" &&
    result.account?.type === "live" &&
    typeof result.account.login === "string" &&
    typeof result.account.server === "string" &&
    !!result.settings &&
    typeof result.currentRiskPct === "number" &&
    Number.isFinite(result.currentRiskPct) &&
    result.currentRiskPct >= 0 &&
    result.currentRiskPct <= 1
  );
}

export default function LiveActivation({
  data,
  busy,
  action,
  serverError,
}: {
  data: AutoState | null;
  busy: boolean;
  action: Action;
  serverError: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const anchor = useRef(0);
  const [opened, setOpened] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledgedRisk, setAcknowledgedRisk] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [notice, setNotice] = useState("");
  const [issue, setIssue] = useState("");
  const [openingFingerprint, setOpeningFingerprint] = useState("");
  const fingerprint = JSON.stringify([
    data?.accountKey,
    data?.account,
    data?.sessionId,
    data?.installationId,
    data?.settingsRevision,
    data?.settings,
  ]);
  const currentFingerprint = useRef(fingerprint);
  useEffect(() => {
    currentFingerprint.current = fingerprint;
    if (opened && fingerprint !== openingFingerprint) {
      generation.current += 1;
    }
  }, [fingerprint, opened, openingFingerprint]);
  useEffect(() => {
    if (!opened || !approval) return;
    const tick = () => {
      const serverNow =
        approval.serverTime + performance.now() - anchor.current;
      setSecondsLeft(
        Math.max(0, Math.ceil((approval.expiresAt - serverNow) / 1000)),
      );
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [opened, approval]);

  function close() {
    generation.current += 1;
    dialogRef.current?.close();
    setOpened(false);
    setApproval(null);
    setConfirmation("");
    setAcknowledgedRisk(false);
  }
  async function open() {
    if (!data?.account || busy) return;
    const request = ++generation.current;
    const expectedFingerprint = fingerprint;
    setAccount({ ...data.account });
    setOpeningFingerprint(expectedFingerprint);
    setApproval(null);
    setConfirmation("");
    setAcknowledgedRisk(false);
    setSecondsLeft(0);
    setIssue("");
    setNotice("");
    setOpened(true);
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
    if (data.account.type === "demo") return;
    const requestedAt = performance.now();
    const response = await action({
      action: "prepare-live",
      accountKey: data.accountKey,
    });
    if (
      request !== generation.current ||
      currentFingerprint.current !== expectedFingerprint
    )
      return;
    if (
      !isApproval(response) ||
      response.accountKey !== data.accountKey ||
      response.account.login !== data.account.login ||
      response.account.server !== data.account.server
    ) {
      setIssue(
        "Live activation could not be prepared. Check the account connection, Demo validation and the message below, then cancel and try again.",
      );
      return;
    }
    // Include round-trip time so a slow connection never extends the displayed review.
    anchor.current = requestedAt;
    setApproval(response);
    setSecondsLeft(
      Math.max(
        0,
        Math.ceil(
          (response.expiresAt -
            response.serverTime -
            (performance.now() - requestedAt)) /
            1000,
        ),
      ),
    );
  }
  const phrase = account ? `ENABLE LIVE ${account.login}` : "";
  const active = data?.account?.type === "live" && data.liveConfirmed;
  const demo = account?.type === "demo";
  const invalidated = openingFingerprint !== fingerprint;
  const expired = !!approval && secondsLeft <= 0;
  const canConfirm =
    !!approval &&
    !busy &&
    !invalidated &&
    !expired &&
    confirmation === phrase &&
    acknowledgedRisk &&
    account?.type === "live";
  const limits = approval?.settings || data?.settings;
  return (
    <section className="inner-card" id="live-activation">
      <div className="inner-card-title">
        <span>LIVE TRADING ACTIVATION</span>
        <span className="inner-tag">{active ? "APPROVED" : "LIVE OFF"}</span>
      </div>
      <h3>Your account. Your approval.</h3>
      <p>
        Live execution is disabled until you approve the exact verified MT5 Live
        account. Approval and automatic execution are separate controls. START
        AI begins analysis and never grants trading permission.
      </p>
      <div className="live-switch-row">
        <span id="live-switch-label">Enable Live Trading</span>
        <button
          className="settings-toggle live-switch"
          type="button"
          role="switch"
          aria-labelledby="live-switch-label"
          aria-describedby="live-switch-help"
          aria-checked={!!active}
          disabled={busy || !data?.account}
          onClick={async () => {
            if (!active) return void open();
            const response = await action({ action: "revoke-live" });
            if (response)
              setNotice("Live approval revoked. New trading is stopped.");
          }}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <p id="live-switch-help" className="inner-caption">
        {data?.account
          ? `${data.account.type === "live" ? "LIVE" : "DEMO"} · ${data.account.login} · ${data.account.server}. `
          : "Waiting for a verified MT5 account. "}
        {data?.account?.type === "demo"
          ? "Demo testing remains available without Live activation."
          : active
            ? "This account has your approval. Trading starts only after Start and every safety check passes."
            : "The switch opens a separate account-specific confirmation. It does not start trading."}
      </p>
      {data?.liveConfirmedAt && active ? (
        <p className="inner-caption">
          Approved {new Date(data.liveConfirmedAt).toLocaleString()}.
        </p>
      ) : null}
      {!data?.demoValidation?.passed ? (
        <p className="inner-caption">
          Live activation also requires a completed real Demo pipeline test for
          the current AI engine. No simulated result can unlock it.
        </p>
      ) : null}
      <div className="inner-notice" role="status">
        {notice}
      </div>
      <a className="inner-text-link" href="#automation">
        Execution authorization ↑
      </a>
      <a className="inner-text-link" href="#emergency-stop">
        Emergency Stop ↓
      </a>
      <a className="inner-text-link" href="#execution-log">
        Execution logs ↓
      </a>
      <dialog
        ref={dialogRef}
        className="live-activation-dialog"
        aria-labelledby="live-dialog-title"
        aria-describedby="live-dialog-description"
        onCancel={close}
        onClose={() => {
          if (opened) close();
        }}
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              !canConfirm ||
              !approval ||
              performance.now() - anchor.current + approval.serverTime >=
                approval.expiresAt
            )
              return;
            const response = await action({
              action: "confirm-live",
              approvalId: approval.approvalId,
              accountKey: approval.accountKey,
              confirmation,
              acknowledgedRisk: true,
            });
            if (response) {
              close();
              setNotice(
                "Live activation approved for this account. Trading remains stopped until you press Start and the safety checks pass.",
              );
            } else {
              setApproval(null);
              setIssue(
                "Activation was not approved. Cancel and review a new activation after resolving the server message below.",
              );
            }
          }}
        >
          {invalidated ? (
            <p className="inner-error" role="alert">
              The account, EA session or risk limits changed. Cancel and review
              a new activation.
            </p>
          ) : null}
          <div className="live-dialog-top">
            <div className="inner-card-title">
              <span>ACCOUNT-SPECIFIC APPROVAL</span>
              <span className="inner-tag">{demo ? "DEMO" : "LIVE"}</span>
            </div>
            <button
              ref={cancelRef}
              className="live-dialog-cancel"
              type="button"
              onClick={close}
              aria-label={
                demo
                  ? "Close Demo account information"
                  : "Cancel and keep Live disabled"
              }
            >
              {demo ? "Close" : "Cancel"}
            </button>
          </div>
          <h2 id="live-dialog-title">
            {demo ? "This is a Demo account" : "Activate real-money trading?"}
          </h2>
          <p id="live-dialog-description">
            {demo
              ? "No Live activation is needed. Close this dialog and use Start Demo AI trading for broker testing, subject to your risk limits."
              : "First-time activation allows ROCKET1000 to request real broker orders only on the Live account shown here. You can lose real money."}
          </p>
          <div className="inner-kv">
            <span>MT5 account number</span>
            <b>{account?.login}</b>
          </div>
          <div className="inner-kv">
            <span>Broker server</span>
            <b>{account?.server}</b>
          </div>
          <div className="inner-kv">
            <span>Verified account type</span>
            <b>{demo ? "DEMO · virtual broker funds" : "LIVE · real money"}</b>
          </div>
          {limits ? (
            <div
              className="live-dialog-limits"
              aria-label="Account risk limits"
            >
              <div className="inner-kv">
                <span>Position sizing</span>
                <b>
                  {limits.sizingMode === "capped"
                    ? `Adaptive · maximum ${limits.lotSize} lots`
                    : "Adaptive · balance and stop risk"}
                </b>
              </div>
              <div className="inner-kv">
                <span>Risk per trade ceiling</span>
                <b>{limits.riskPerTradePct}%</b>
              </div>
              {approval ? (
                <div className="inner-kv">
                  <span>Current adaptive risk</span>
                  <b>{approval.currentRiskPct.toFixed(2)}%</b>
                </div>
              ) : null}
              <div className="inner-kv">
                <span>Maximum daily loss</span>
                <b>{limits.maxDailyLossPct}%</b>
              </div>
              <div className="inner-kv">
                <span>Maximum drawdown</span>
                <b>{limits.maxDrawdownPct}%</b>
              </div>
              <div className="inner-kv">
                <span>Maximum open positions</span>
                <b>{limits.maxPositions}</b>
              </div>
              <p className="inner-caption">
                Protective stop-loss required. Margin, spread, aggregate
                exposure and broker checks still apply. Gaps and slippage can
                exceed estimated risk.
              </p>
            </div>
          ) : null}
          {!demo ? (
            <>
              <p className="inner-caption" role="status">
                {expired
                  ? "This approval expired. Cancel and open a new confirmation."
                  : approval
                    ? `Confirmation expires in ${secondsLeft} seconds.`
                    : issue
                      ? "Approval unavailable."
                      : "Preparing a secure approval from the server…"}
              </p>
              <label className="trade-field">
                Type {phrase}
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmation}
                  disabled={!approval || expired || invalidated || busy}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              <label className="live-risk-ack">
                <input
                  type="checkbox"
                  checked={acknowledgedRisk}
                  disabled={!approval || expired || invalidated || busy}
                  onChange={(event) =>
                    setAcknowledgedRisk(event.target.checked)
                  }
                />
                <span>
                  I explicitly approve real-money trading for account{" "}
                  {account?.login} at {account?.server}, accept the saved risk
                  limits, and understand that losses are possible.
                </span>
              </label>
              <p>
                Approval leaves automation stopped. Start is separate. Emergency
                Stop disables new orders and revokes Live approval; an order
                already submitted to the broker may still fill.
              </p>
            </>
          ) : null}
          <div className="inner-error" role="alert">
            {issue}
            {serverError ? ` ${serverError}` : ""}
          </div>
          <div className="live-dialog-actions">
            <button className="action-outline" type="button" onClick={close}>
              {demo
                ? "Close — keep Demo available"
                : "Cancel — keep Live disabled"}
            </button>
            {!demo ? (
              <button
                className="action-red"
                type="submit"
                disabled={!canConfirm}
              >
                I approve Live activation for {account?.login}
              </button>
            ) : null}
          </div>
        </form>
      </dialog>
    </section>
  );
}
