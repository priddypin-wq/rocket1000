"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { mt5Api } from "../../lib/mt5-client";
import {
  confirmedRevocation,
  verifiedConnectionResponse,
} from "../../lib/action-confirmation.mjs";
import { requestEaDownload } from "../../lib/browser-download.mjs";
import { ENGINE_VERSION } from "../../lib/engine-version.mjs";
import { brokerNumber, useOrders } from "../../lib/use-orders";
import { ConnectedSymbols } from "./trading-dashboard";
type Connection = {
  id: string;
  status: string;
  installation: null | {
    id: string;
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
  const replacementReview = useRef<{
    installationId: string;
    requestId: string;
  } | null>(null);
  function reviewReplacement(format: "package" | "source") {
    if (c?.installation?.id) {
      replacementReview.current = {
        installationId: c.installation.id,
        requestId: crypto.randomUUID(),
      };
      setReplacementFormat(format);
    }
  }
  function dismissReplacement() {
    replacementReview.current = null;
    setReplacementFormat(null);
  }
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
      const verified = verifiedConnectionResponse(
        await (await mt5Api("generate", {})).json(),
        c?.id,
      );
      if (verified.installationId !== (c?.installation?.id ?? null))
        throw Error(
          "The EA installation changed. Check its status before copying the URL.",
        );
      await navigator.clipboard.writeText(verified.serverUrl).catch(() => {
        throw Error(
          "Clipboard permission is unavailable. Select the displayed URL to copy it.",
        );
      });
      setNotice("MT5 URL copied. Paste it into the allowed WebRequest URLs.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not copy the verified MT5 URL.",
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
    if (!c || networkError) {
      setError(
        "Wait for your private workspace connection, then download again.",
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
      const review = replaceCredential ? replacementReview.current : null;
      if (replaceCredential && !review)
        throw Error("Review the current EA installation before replacing it.");
      if (!review && generated.installationId !== (c?.installation?.id ?? null))
        throw Error(
          "The EA installation changed. Refresh its status before downloading.",
        );
      const response = await mt5Api("download", {
        connectionId: generated.connectionId,
        format: format === "package" ? "ai-package" : "source",
        expectedInstallationId:
          review?.installationId ?? generated.installationId,
        ...(review
          ? { replaceCredential: true, requestId: review.requestId }
          : {}),
      });
      await requestEaDownload(response, {
        connectionId: generated.connectionId,
        installationId:
          review?.installationId ??
          (c?.installation &&
          !c.installation.revokedAt &&
          c.installation.expiresAt > generated.verifiedAt
            ? c.installation.id
            : null),
        replacing: replaceCredential,
        format,
        engineVersion: ENGINE_VERSION,
      });
      dismissReplacement();
      setNotice(
        format === "source"
          ? "MetaEditor source download requested. Open the saved ROCKET1000_EA.mq5 in MetaEditor, save it in your MT5 MQL5/Experts/ROCKET1000 folder and compile. Its connection configuration is included."
          : "EA package download requested. Extract the saved ROCKET1000_EA.zip and copy its MQL5 folder into your MT5 data folder. The EA uses the verified OpenAI model in this workspace.",
      );
      await refreshAfterAction();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
      if (
        e instanceof Error &&
        (e as Error & { code?: string }).code === "EA_ROTATION_REVIEW_REQUIRED"
      )
        reviewReplacement(format);
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
        await mt5Api("revoke", {
          connectionId: c.id,
          expectedInstallationId: c.installation.id,
        })
      ).json();
      const revokedAt = confirmedRevocation(revoked, c.id, c.installation.id);
      setState((previous) =>
        previous
          ? {
              ...previous,
              connections: previous.connections.map((connection) =>
                connection.id === c.id &&
                connection.installation?.id === c.installation?.id
                  ? {
                      ...connection,
                      status: "Authentication Failed",
                      installation: { ...connection.installation!, revokedAt },
                    }
                  : connection,
              ),
            }
          : previous,
      );
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
          Use the same EA on a Demo or Live account. Test your model in{" "}
          <Link className="inner-text-link" href="#ai-connection">
            Connect AI
          </Link>
          , then download your personal EA.
        </p>
        <button
          className="action-red"
          disabled={!c || !!busy || !!networkError}
          title={networkError || undefined}
          onClick={() => {
            void download();
          }}
        >
          {busy === "download"
            ? "Preparing your EA…"
            : "Download ROCKET1000 EA"}
        </button>
        <div className="url-field">
          <span>MT5 WebRequest URL</span>
          <code>
            {state?.serverUrl || "Available after the server is verified"}
          </code>
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
        <p className="inner-caption">
          Copy both folders from the ZIP into your MT5 data folder. Allow the
          WebRequest URL shown here and attach the EA to one chart. The first
          heartbeat identifies your broker account and its Demo or Live type.
        </p>
        <details className="settings-inline-details">
          <summary>Connection repair & MetaEditor source</summary>
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
              onClick={() => reviewReplacement("package")}
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
          else dismissReplacement();
        }}
        onClose={dismissReplacement}
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
            onClick={dismissReplacement}
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
