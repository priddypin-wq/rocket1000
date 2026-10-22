"use client";
import { useEffect, useState } from "react";
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
    : c?.status === "Connected"
      ? "Connected"
      : ["Authentication Failed", "Account Mismatch"].includes(c?.status || "")
        ? "Connection Error"
        : "Disconnected";
  async function refresh() {
    setState(await (await mt5Api("connections")).json());
  }
  async function generate() {
    setBusy("generate");
    setError("");
    setNotice("");
    try {
      await mt5Api("generate", {});
      await refresh();
      setNotice(
        "HTTPS connection verified. Copy the URL and download your EA.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection generation failed");
    } finally {
      setBusy("");
    }
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
  async function download() {
    if (!state) return;
    setBusy("download");
    setError("");
    try {
      const generated = await (await mt5Api("generate", {})).json();
      const response = await mt5Api("download", {
        connectionId: generated.connectionId,
        format: "package",
      });
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "ROCKET1000_EA.zip";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      await refresh();
      setNotice(
        "Your verified compiled EA and private configuration are in ROCKET1000_EA.zip. Extract it and copy its MQL5 folder into your MT5 data folder.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
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
          onClick={() => {
            void copy();
          }}
        >
          Copy EA Connection URL
        </button>
        <button
          className="action-white"
          disabled={!state?.downloadReady || !!busy || !!networkError}
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
      <section className="inner-card">
        <h3>Install & connect</h3>
        <ol className="inner-list">
          <li>
            Download and extract ROCKET1000_EA.zip. In MT5, choose File → Open
            Data Folder.
          </li>
          <li>
            Copy the package’s MQL5 folder into that data folder, merging its
            Experts and Files folders. Keep the bundled private config in place.
          </li>
          <li>
            Copy the MT5 URL into Tools → Options → Expert Advisors → Allow
            WebRequest.
          </li>
          <li>
            Log into your Demo or Live broker account and attach ROCKET1000 EA
            to the broker symbol you want it to analyze. The EA detects account
            type and reports the exact broker symbol automatically.
          </li>
          <li>
            Wait for verification, set your risk limits in Settings and enable
            this EA&#39;s Algo Trading permission. Save and test your OpenAI key
            in Settings, then press START AI on Home for analysis. Broker
            execution requires separate account authorization in Settings.
          </li>
        </ol>
        <p className="inner-caption">
          No email or token entry. This browser owns the connection. A new
          download replaces the old token. Switching Demo or Live accounts
          verifies the new broker account and stops automation until you start
          again.
        </p>
        <button
          className="action-outline"
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
      </section>
      <ConnectedSymbols data={orders.data} error={orders.error} />
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
