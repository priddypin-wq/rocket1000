"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { mt5Api } from "../../lib/mt5-client";
import { verifiedConnectionResponse } from "../../lib/action-confirmation.mjs";
import { requestBrowserDownload } from "../../lib/browser-download.mjs";
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
  const actionInFlight = useRef(false);
  const connectionGeneration = useRef(0);
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
      if (pending || actionInFlight.current) return;
      pending = true;
      const current = ++connectionGeneration.current;
      try {
        const next = await (await mt5Api("connections")).json();
        if (active && current === connectionGeneration.current) {
          setState(next);
          setNetworkError("");
        }
      } catch (e) {
        if (active && current === connectionGeneration.current)
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
    orders.data.connection?.id === c?.id &&
    orders.data.account.login === c?.installation?.accountLogin &&
    orders.data.account.server === c?.installation?.brokerServer &&
    orders.data.account.type === c?.installation?.accountType
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
      ? "Checking connection"
      : c?.status === "Connected"
        ? "Connected"
        : ["Authentication Failed", "Account Mismatch"].includes(
              c?.status || "",
            )
          ? "Connection Error"
          : "Disconnected";
  async function refresh() {
    const current = ++connectionGeneration.current;
    const next = await (await mt5Api("connections")).json();
    if (current === connectionGeneration.current) {
      setState(next);
      setNetworkError("");
    }
  }
  async function refreshAfterAction() {
    try {
      await refresh();
    } catch {
      setNetworkError(
        "The action succeeded, but connection status could not refresh. Check your connection before trying another action.",
      );
    }
  }
  async function generate() {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    connectionGeneration.current += 1;
    setBusy("generate");
    setError("");
    setNotice("");
    try {
      verifiedConnectionResponse(
        await (await mt5Api("generate", {})).json(),
        c?.id,
      );
      setNotice(
        "HTTPS connection verified. Copy the URL and download your EA.",
      );
      await refreshAfterAction();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection generation failed");
    } finally {
      actionInFlight.current = false;
      setBusy("");
    }
  }
  async function copy() {
    if (actionInFlight.current) return;
    setError("");
    setNotice("");
    if (!state?.serverUrl) {
      setError("Generate the connection before copying its MT5 URL.");
      return;
    }
    actionInFlight.current = true;
    setBusy("copy");
    try {
      await navigator.clipboard.writeText(state.serverUrl);
      setNotice("MT5 URL copied. Paste it into the allowed WebRequest URLs.");
    } catch {
      setError(
        "Clipboard permission is unavailable. Select the displayed URL to copy it.",
      );
    } finally {
      actionInFlight.current = false;
      setBusy("");
    }
  }
  async function download(
    format: "package" | "source" = "package",
    replaceCredential = false,
  ) {
    if (actionInFlight.current) return;
    if (!state?.downloadReady || networkError) {
      setError(
        "Generate and verify the connection before downloading your EA.",
      );
      return;
    }
    actionInFlight.current = true;
    connectionGeneration.current += 1;
    setBusy("download");
    setError("");
    setNotice("");
    try {
      const generated = verifiedConnectionResponse(
        await (await mt5Api("generate", {})).json(),
        c?.id,
      );
      const response = await mt5Api("download", {
        connectionId: generated.connectionId,
        format,
        ...(replaceCredential ? { replaceCredential: true } : {}),
      });
      await requestBrowserDownload(response, {
        filename: `ROCKET1000_EA.${format === "source" ? "mq5" : "zip"}`,
        contentTypes: [format === "source" ? "text/x-mql5" : "application/zip"],
      });
      setReplacementFormat(null);
      setNotice(
        format === "source"
          ? "MetaEditor source download requested. Open the saved ROCKET1000_EA.mq5 in MetaEditor, save it in your MT5 MQL5/Experts/ROCKET1000 folder and compile. Its connection configuration is included."
          : "EA package download requested. Extract the saved ROCKET1000_EA.zip and copy its MQL5 folder into your MT5 data folder. The compiled EA and private configuration are included.",
      );
      await refreshAfterAction();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
      if (
        e instanceof Error &&
        (e as Error & { code?: string }).code === "EA_ROTATION_REVIEW_REQUIRED"
      )
        setReplacementFormat(format);
    } finally {
      actionInFlight.current = false;
      setBusy("");
    }
  }
  async function revoke() {
    if (actionInFlight.current) return;
    setError("");
    setNotice("");
    if (!c?.installation || c.installation.revokedAt) {
      setError("There is no active EA credential to revoke.");
      return;
    }
    actionInFlight.current = true;
    connectionGeneration.current += 1;
    setBusy("revoke");
    try {
      const revoked = await (
        await mt5Api("revoke", { connectionId: c.id })
      ).json();
      if (revoked?.ok !== true)
        throw Error("The server did not confirm EA credential revocation.");
      setNotice("EA credential revoked.");
      await refreshAfterAction();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revocation failed");
    } finally {
      actionInFlight.current = false;
      setBusy("");
    }
  }
  return (
    <>
      <section className="inner-card">
        <div className="inner-card-title">
          <span>MT5 CONNECTION</span>
          <span
            className={`inner-tag ${status === "Connected" ? "tag-connected" : ""}`}
            role="status"
          >
            {status}
          </span>
        </div>
        <h2>Connect your terminal.</h2>
        <p>
          One EA for Demo and Live. Download the verified compiled EA package;
          its private connection configuration is already included.
        </p>
        <button
          className="action-red"
          disabled={!!busy}
          onClick={() => {
            void generate();
          }}
        >
          {busy === "generate"
            ? "Verifying HTTPS server…"
            : "Generate Connection"}
        </button>
        <div className="url-field">
          <span>MT5 WebRequest URL</span>
          <code>{state?.serverUrl || "Generate a connection first"}</code>
        </div>
        <button
          className="action-outline"
          disabled={!state?.serverUrl || !!busy}
          title={
            !state?.serverUrl
              ? "Generate and verify the HTTPS connection first."
              : undefined
          }
          onClick={() => {
            void copy();
          }}
        >
          Copy EA Connection URL
        </button>
        <button
          className="action-white"
          disabled={!state?.downloadReady || !!busy || !!networkError}
          title={
            networkError ||
            (!state?.downloadReady
              ? state?.provisioningError ||
                "Generate the verified connection before downloading."
              : undefined)
          }
          onClick={() => {
            void download();
          }}
        >
          {busy === "download"
            ? "Preparing your EA…"
            : "Download Rocket1000 EA (.ex5)"}
        </button>
        <p className="inner-caption">
          ZIP contains the actual compiled .ex5, personalized configuration and
          instructions. Download is available only after build verification.
        </p>
        <details className="settings-inline-details">
          <summary>Connection repair & MetaEditor source</summary>
          <p>
            If MT5 reports a missing configuration, reinstall both folders from
            the compiled package, or download the self-contained MetaEditor
            source below. Keep either download private.
          </p>
          <button
            className="action-outline"
            disabled={!state?.downloadReady || !!busy || !!networkError}
            onClick={() => void download("source")}
          >
            Download MetaEditor source (.mq5)
          </button>
          <p className="inner-caption">
            Open the downloaded file in MetaEditor and compile it. Automatic
            opening depends on the file association configured on your computer.
            No manual URL or token entry is required.
          </p>
          {c?.installation && !c.installation.revokedAt ? (
            <button
              className="inner-text-button"
              disabled={!!busy}
              onClick={() => setReplacementFormat("package")}
            >
              Replace EA installation…
            </button>
          ) : null}
          <button
            className="action-outline"
            disabled={!c?.installation || !!c.installation.revokedAt || !!busy}
            title={
              !c?.installation || c.installation.revokedAt
                ? "No active EA credential is available to revoke."
                : undefined
            }
            onClick={() => void revoke()}
          >
            Revoke EA access
          </button>
        </details>
        <div className="inner-error" role="alert">
          {networkError || error || state?.provisioningError}
        </div>
        <div className="inner-notice" role="status">
          {notice}
        </div>
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
        onCancel={(event) => {
          if (actionInFlight.current) event.preventDefault();
          else setReplacementFormat(null);
        }}
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
