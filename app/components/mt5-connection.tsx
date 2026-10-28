"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { mt5Api } from "../../lib/mt5-client";
import { brokerNumber, useOrders } from "../../lib/use-orders";
import { ConnectedSymbols } from "./trading-dashboard";
type Connection = {
  id: string;
  status: string;
  installation: null | {
    accountLogin: string | null;
    brokerServer: string | null;
    accountType: "demo" | "live" | null;
    lastHeartbeat: number | null;
    expiresAt: number;
    revokedAt: number | null;
  };
};
type Workspace = {
  connections: Connection[];
  serverUrl: string | null;
  downloadReady: boolean;
  provisioningError: string;
  verifiedAt: number | null;
};
export default function Mt5Connection() {
  const orders = useOrders();
  const [state, setState] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [networkError, setNetworkError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [replacementFormat, setReplacementFormat] = useState<
    "package" | "source" | null
  >(null);
  const replacementDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (replacementFormat) replacementDialog.current?.showModal();
    else replacementDialog.current?.close();
  }, [replacementFormat]);
  useEffect(() => {
    let active = true;
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        const next = await (await mt5Api("connections")).json();
        if (active) {
          setState(next);
          setNetworkError("");
        }
      } catch (e) {
        if (active)
          setNetworkError(
            e instanceof Error ? e.message : "Connection server unavailable",
          );
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const c = state?.connections[0];
  const verifiedAccount =
    orders.data?.account &&
    orders.data.account.login === c?.installation?.accountLogin &&
    orders.data.account.server === c?.installation?.brokerServer
      ? orders.data.account
      : null;
  const accountLabel =
    c?.installation?.accountType === "demo"
      ? "Demo"
      : c?.installation?.accountType === "live"
        ? "Live"
        : null;
  const status = networkError
    ? "Connection Error"
    : !state
      ? "Checking"
      : c?.status === "Connected"
      ? "Connected"
      : ["Authentication Failed", "Account Mismatch"].includes(c?.status || "")
        ? "Connection Error"
        : "Disconnected";
  async function refresh() {
    setState(await (await mt5Api("connections")).json());
  }
  async function copy() {
    if (!state?.serverUrl) return;
    try {
      await navigator.clipboard.writeText(state.serverUrl);
      setNotice("MT5 URL copied. Paste it into the allowed WebRequest URLs.");
    } catch {
      setError(
        "Clipboard permission is unavailable. Select the displayed URL to copy it.",
      );
    }
  }
  async function download(
    format: "package" | "source" = "package",
    replaceCredential = false,
  ) {
    if (!state) return;
    setBusy("download");
    setError("");
    try {
      // Generate/verify the single existing connection automatically.
      // The backend reuses the existing connection and sealed EA credential.
      const generated = await (await mt5Api("generate", {})).json();
      await refresh();
      const response = await mt5Api("download", {
        connectionId: generated.connectionId,
        format,
        ...(replaceCredential ? { replaceCredential: true } : {}),
      });
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `ROCKET1000_EA.${format === "source" ? "mq5" : "zip"}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      await refresh();
      setReplacementFormat(null);
      setNotice(
        format === "source"
          ? "Your private preconfigured ROCKET1000_EA.mq5 is downloaded. Open it in MetaEditor, save it in your MT5 MQL5/Experts/ROCKET1000 folder and compile. This source includes its connection configuration."
          : "Your verified compiled EA and private configuration are in ROCKET1000_EA.zip. Extract it and copy its MQL5 folder into your MT5 data folder.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
      if (
        e instanceof Error &&
        (e as Error & { code?: string }).code === "EA_ROTATION_REVIEW_REQUIRED"
      )
        setReplacementFormat(format);
    } finally {
      setBusy("");
    }
  }
  const connectionIssue =
    networkError ||
    error ||
    (state?.provisioningError?.startsWith("Generate Connection")
      ? ""
      : state?.provisioningError || "");
  return (
    <>
      <section className="inner-card" aria-labelledby="single-mt5-connection">
        <div className="inner-card-title">
          <span id="single-mt5-connection">ONE MT5 CONNECTION</span>
          <span
            className={`inner-tag ${status === "Connected" && verifiedAccount ? "tag-connected" : ""}`}
            role="status"
          >
            {status === "Connected" && !verifiedAccount
              ? "Verifying broker"
              : status}
          </span>
        </div>
        <h2>ROCKET1000 App ↔ EA ↔ MT5</h2>
        <p>
          One official ROCKET1000 EA links your app to the broker account already
          signed in on MetaTrader 5. No separate app broker login, pairing code,
          or second EA connection is required.
        </p>
        {verifiedAccount ? (
          <p className="inner-notice" role="status">
            Verified: {verifiedAccount.brokerName || verifiedAccount.server} ·{" "}
            {verifiedAccount.login} · {accountLabel?.toUpperCase() || "MT5"}
          </p>
        ) : (
          <p className="inner-caption" role="status">
            {status === "Connection Error"
              ? "Connection needs attention. Review the error below."
              : "Waiting for your ROCKET1000 EA to report a verified broker account."}
          </p>
        )}
        <button
          type="button"
          className="action-red"
          disabled={!state || !!busy || !!networkError}
          onClick={() => void download()}
        >
          {busy === "download"
            ? "Preparing your EA…"
            : c?.installation && !c.installation.revokedAt
              ? "Download the same EA package"
              : "Prepare & download ROCKET1000 EA"}
        </button>
        <p className="inner-caption">
          This one action verifies your app server and downloads the personalized,
          compiled EA with its private configuration. Re-downloads reuse the
          existing installation when its saved credential is available. This
          does not enable Auto Trading or place an order.
        </p>
        <div className="settings-inline-details">
          <h3>Complete the setup in Windows MT5</h3>
          <ol>
            <li>
              In MT5, select File → Open Data Folder. Extract the downloaded ZIP
              and copy its MQL5 folder into that data folder.
            </li>
            <li>
              In Tools → Options → Expert Advisors, allow WebRequest for this
              HTTPS address. This is a required MT5 security permission, not
              another connection or password.
              <div className="url-field">
                <span>Allowed MT5 WebRequest address</span>
                <code>
                  {state?.serverUrl || "Prepare your EA to reveal the address"}
                </code>
              </div>
              <button
                className="action-outline"
                type="button"
                disabled={!state?.serverUrl || !!busy}
                onClick={() => void copy()}
              >
                Copy allowed MT5 address
              </button>
            </li>
            <li>
              Sign in to your broker inside MT5, refresh Navigator and attach
              ROCKET1000 EA to one chart. Keep the Windows terminal or VPS
              running; this app will show Connected after verification.
            </li>
          </ol>
        </div>
        <details className="settings-inline-details">
          <summary>Repair this EA installation (advanced)</summary>
          <p>
            If MT5 cannot find the EA configuration, reinstall both MQL5
            folders from the same package. The editable MetaEditor source is
            available as a fallback; it uses the same single connection.
          </p>
          <button
            className="action-outline"
            type="button"
            disabled={!state || !!busy || !!networkError}
            onClick={() => void download("source")}
          >
            Download MetaEditor source (.mq5)
          </button>
          {c?.installation && !c.installation.revokedAt ? (
            <button
              className="inner-text-button"
              type="button"
              disabled={!!busy}
              onClick={() => setReplacementFormat("package")}
            >
              Replace EA installation…
            </button>
          ) : null}
          <button
            className="action-outline"
            type="button"
            disabled={!c?.installation || !!c.installation.revokedAt || !!busy}
            onClick={async () => {
              if (!c) return;
              try {
                await mt5Api("revoke", { connectionId: c.id });
                await refresh();
                setNotice("EA credential revoked.");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Revocation failed");
              }
            }}
          >
            Revoke EA access
          </button>
        </details>
        {connectionIssue ? (
          <p className="inner-error" role="alert">
            {connectionIssue}
          </p>
        ) : null}
        {notice ? (
          <p className="inner-notice" role="status">
            {notice}
          </p>
        ) : null}
      </section>
      <section className="inner-card">
        <div className="inner-card-title">
          <span>TERMINAL STATUS</span>
          <span>
            {accountLabel
              ? `${accountLabel.toUpperCase()} ACCOUNT`
              : "ACCOUNT NOT VERIFIED"}
          </span>
        </div>
        {[
          ["Verification state", c?.status || "Waiting for server"],
          ["Account", c?.installation?.accountLogin || "Not connected"],
          ["Broker server", c?.installation?.brokerServer || "—"],
          [
            "Verified broker",
            verifiedAccount?.brokerName || "Waiting for broker data",
          ],
          ["Account type", accountLabel || "—"],
          [
            "Balance",
            verifiedAccount
              ? `${brokerNumber(verifiedAccount.balance, 2)} ${verifiedAccount.currency || ""}`
              : "Waiting for MT5",
          ],
          [
            "Equity",
            verifiedAccount
              ? `${brokerNumber(verifiedAccount.equity, 2)} ${verifiedAccount.currency || ""}`
              : "Waiting for MT5",
          ],
          [
            "Last seen online",
            c?.installation?.lastHeartbeat
              ? new Date(c.installation.lastHeartbeat).toLocaleString()
              : "Never",
          ],
          ["Margin", brokerNumber(verifiedAccount?.margin, 2)],
          ["Free margin", brokerNumber(verifiedAccount?.freeMargin, 2)],
          ["Floating P/L", brokerNumber(verifiedAccount?.floatingProfit, 2)],
          [
            "Broker positions / orders",
            `${verifiedAccount?.positionsCount ?? "—"} / ${verifiedAccount?.ordersCount ?? "—"}`,
          ],
          [
            "Broker / EA permissions",
            verifiedAccount?.tradingAllowed
              ? "Enabled"
              : "Not verified / disabled",
          ],
          [
            "HTTPS verified",
            state?.verifiedAt
              ? new Date(state.verifiedAt).toLocaleString()
              : "Not verified",
          ],
        ].map(([label, value]) => (
          <div className="inner-kv" key={label}>
            <span>{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </section>
      <ConnectedSymbols data={orders.data} error={orders.error} />
      <dialog
        ref={replacementDialog}
        className="live-activation-dialog"
        aria-labelledby="replace-ea-title"
        aria-describedby="replace-ea-description"
        onCancel={() => setReplacementFormat(null)}
        onClose={() => setReplacementFormat(null)}
      >
        <h2 id="replace-ea-title">Replace this EA installation?</h2>
        <p id="replace-ea-description">
          This creates a new private EA credential and disables the previous
          installation. Any old EA will stop authenticating. Install the new
          download in MT5 before restarting AI.
        </p>
        <p>
          Your backend address stays the same. Existing broker positions remain
          open; this action does not close trades.
        </p>
        <div className="engine-actions">
          <button
            className="action-outline"
            disabled={!!busy}
            onClick={() => setReplacementFormat(null)}
          >
            Cancel
          </button>
          <button
            className="action-red"
            disabled={!!busy || !replacementFormat}
            onClick={() => {
              if (replacementFormat) void download(replacementFormat, true);
            }}
          >
            {busy === "download"
              ? "Preparing replacement…"
              : "Replace & download"}
          </button>
        </div>
      </dialog>
      <section className="inner-card">
        <div className="inner-card-title">
          <span>ANALYSIS & BROKER ORDERS</span>
          <span className="inner-tag">VERIFIED DATA</span>
        </div>
        <p>
          View AI proposals, Rocket1000-owned positions and confirmed broker
          results in Market. Risk limits remain independently enforced.
        </p>
        <Link className="action-outline inner-link-button" href="/dashboard">
          Open Market →
        </Link>
      </section>
    </>
  );
}
