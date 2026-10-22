"use client";
import { useState } from "react";
import type { AdaptiveProfile, TradingMode } from "../../lib/use-workspace";
export type TradeSettings = {
  strategy: "adaptive" | "price-action" | "scalping";
  tradingMode: TradingMode;
  sizingMode: "adaptive" | "capped";
  lotSize: number;
  stopLossPoints: number;
  takeProfitPoints: number;
  trailingStopPoints: number;
  breakEvenPoints: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxPositions: number;
  minConfidence: number;
  intervalSeconds: number;
  maxSpreadPoints: number;
  maxSlippagePoints: number;
};
export type AutoState = {
  account: null | { login: string; server: string; type: "demo" | "live" };
  accountKey: string;
  liveConfirmed: boolean;
  liveConfirmedAt?: number | null;
  sessionId?: string | null;
  installationId?: string | null;
  settingsRevision?: string;
  activationEvents?: { event: string; createdAt: number }[];
  demoValidation: {
    passed: boolean;
    engineVersion: string;
    completedAt: number | null;
  };
  profile: AdaptiveProfile | null;
  sizing: null | {
    mode: "adaptive" | "capped";
    basisBalance: number;
    riskBudget: number;
    currency: string;
    lotCap: number;
  };
  performance: {
    available: boolean;
    from?: number;
    to?: number;
    closedDeals?: number;
    wins?: number;
    losses?: number;
    grossProfit?: number;
    grossLoss?: number;
    netProfit?: number;
    currency?: string;
  };
  connectionBlockers: string[];
  permissionActive: boolean;
  settings: TradeSettings;
  automation: null | {
    state: string;
    waiting?: boolean;
    lastCycle: number;
    lastError: string | null;
  };
  risk: null | {
    dailyLoss: number;
    realizedToday: number | null;
    drawdownPct: number | null;
  };
};
type Action = (value: unknown) => Promise<unknown>;
const fields: [
  Exclude<keyof TradeSettings, "tradingMode" | "sizingMode" | "strategy">,
  string,
  number,
  number,
  number,
][] = [
  ["lotSize", "Optional maximum lots", 0.00000001, 100, 0.01],
  ["stopLossPoints", "Stop-loss distance (points)", 1, 10000000, 1],
  ["takeProfitPoints", "Take-profit distance (points)", 1, 10000000, 1],
  ["trailingStopPoints", "Trailing stop distance (0 = off)", 0, 10000000, 1],
  ["breakEvenPoints", "Break-even trigger (points, 0 = off)", 0, 10000000, 1],
  ["riskPerTradePct", "Risk per trade (%)", 0.1, 1, 0.1],
  ["maxDailyLossPct", "Maximum daily loss (%)", 0.1, 5, 0.1],
  ["maxDrawdownPct", "Maximum drawdown (%)", 0.1, 5, 0.1],
  ["maxPositions", "Maximum open positions", 1, 3, 1],
  ["minConfidence", "Minimum AI confidence (0–1)", 0.5, 1, 0.01],
  ["intervalSeconds", "Minimum analysis interval (seconds)", 60, 3600, 1],
  ["maxSpreadPoints", "Maximum spread (points)", 1, 1000, 1],
  ["maxSlippagePoints", "Price-change allowance (points)", 1, 1000, 1],
];
export default function AutomationControls({
  data,
  busy,
  action,
  advancedOnly = false,
}: {
  data: AutoState | null;
  busy: boolean;
  action: Action;
  advancedOnly?: boolean;
}) {
  const mode = data?.account?.type === "live" ? "Live" : "Demo";
  const running = data?.automation?.state === "running";
  const liveBlocked = data?.account?.type === "live" && !data.liveConfirmed;
  const demoBlocked =
    data?.account?.type === "live" && !data.demoValidation?.passed;
  return (
    <>
      {!advancedOnly ? (
        <section className="inner-card" id="automation">
          <div className="inner-card-title">
            <span>AUTOMATIC BROKER TRADING</span>
            <span className="inner-tag">
              {running
                ? data?.automation?.waiting
                  ? "WAITING FOR SAFETY"
                  : "RUNNING"
                : "STOPPED"}
            </span>
          </div>
          <h3>
            {data?.account
              ? `${mode} · ${data.account.login}`
              : "Connect MT5 to begin"}
          </h3>
          <p>
            Uses genuine MT5 broker orders. GPT-6.1 Sol evaluates fresh M1, M5,
            M15 and H1 candles. Approved BUY/SELL signals open trades
            automatically; opposing signals close this connection&#39;s
            positions, and protection changes require an explicit AI position
            action.
          </p>
          <div className="inner-kv">
            <span>Demo pipeline validation</span>
            <b>
              {data?.demoValidation?.passed
                ? "Passed for this AI engine"
                : "Not completed · Live trading locked"}
            </b>
          </div>
          {!data?.demoValidation?.passed ? (
            <p className="inner-caption">
              Live trading stays locked until a real AI signal completes the
              Demo broker pipeline. A simulated test or authentication setup
              cannot unlock it. Existing positions and risk limits may block
              that test.
            </p>
          ) : data.demoValidation.completedAt ? (
            <p className="inner-caption">
              Demo validation completed{" "}
              {new Date(data.demoValidation.completedAt).toLocaleString()}.
            </p>
          ) : null}
          {liveBlocked ? (
            <p>
              <a className="inner-text-link" href="#live-activation">
                Live is disabled. Review account-specific Live activation above
                ↑
              </a>
            </p>
          ) : data?.account?.type === "live" ? (
            <p className="inner-caption">
              Live account approved ·{" "}
              {running ? "strategy running" : "strategy stopped"}. Approval and
              Start are separate controls.
            </p>
          ) : null}
          <button
            className="action-red"
            disabled={
              busy ||
              !data?.account ||
              liveBlocked ||
              demoBlocked ||
              !!data?.connectionBlockers.length ||
              running
            }
            onClick={() =>
              void action({
                action: "start-auto",
                accountKey: data?.accountKey,
              })
            }
          >
            Start {mode} AI trading
          </button>
          <button
            className="action-outline emergency-stop-button"
            id="emergency-stop"
            disabled={busy || !data?.account}
            onClick={() => void action({ action: "disable" })}
          >
            Emergency Stop — stop new trades & revoke Live
          </button>
          <p>
            Account switches and reconnects stop automation. Start again after
            verification. Permission lasts up to 24 hours in the current
            session. Emergency Stop cancels queued commands and revokes Live
            approval; an order already sent to the broker may still fill.
            Existing broker stop-losses remain active. Stop does not close
            existing positions.
          </p>
          {data?.automation?.lastError ? (
            <p className="inner-error" role="status">
              {data.automation.lastError}
            </p>
          ) : null}
          {data?.automation?.lastCycle ? (
            <p className="inner-caption">
              Last analysis cycle{" "}
              {new Date(data.automation.lastCycle).toLocaleString()}.
            </p>
          ) : null}
          {data?.profile ? (
            <>
              <div className="inner-kv">
                <span>Selected mode</span>
                <b>
                  {data.profile.mode === "aggressive"
                    ? "Aggressive"
                    : "Balanced"}
                </b>
              </div>
              <div className="inner-kv">
                <span>Current market regime</span>
                <b>{data.profile.regime}</b>
              </div>
              <div className="inner-kv">
                <span>Adaptive risk per trade</span>
                <b>{data.profile.effectiveRiskPct.toFixed(2)}%</b>
              </div>
              <div className="inner-kv">
                <span>Scalping conditions</span>
                <b>{data.profile.scalpingEligible ? "Eligible" : "Waiting"}</b>
              </div>
              <p className="inner-caption">{data.profile.scalpingReason}</p>
            </>
          ) : null}
          {data?.sizing ? (
            <>
              <div className="inner-kv">
                <span>Position sizing</span>
                <b>
                  {data.sizing.mode === "adaptive"
                    ? "Automatic · balance and stop risk"
                    : "Automatic · with your lot cap"}
                </b>
              </div>
              <div className="inner-kv">
                <span>Lower of balance and equity</span>
                <b>
                  {data.sizing.basisBalance.toFixed(2)} {data.sizing.currency}
                </b>
              </div>
              <div className="inner-kv">
                <span>Current stop-risk budget per new trade</span>
                <b>
                  {data.sizing.riskBudget.toFixed(2)} {data.sizing.currency}
                </b>
              </div>
              <p className="inner-caption">
                The final lot size is calculated only after a fresh signal
                supplies its stop-loss, then rounded down to your broker&#39;s
                volume step. Margin, existing exposure and all account limits
                must also pass.
              </p>
            </>
          ) : null}
          {data?.risk ? (
            <>
              <div className="inner-kv">
                <span>Realized today</span>
                <b>
                  {data.risk.realizedToday === null
                    ? "Waiting"
                    : data.risk.realizedToday.toFixed(2)}
                </b>
              </div>
              <div className="inner-kv">
                <span>Daily loss used</span>
                <b>{data.risk.dailyLoss.toFixed(2)}</b>
              </div>
              <div className="inner-kv">
                <span>Equity drawdown</span>
                <b>
                  {data.risk.drawdownPct === null
                    ? "Waiting"
                    : `${data.risk.drawdownPct.toFixed(2)}%`}
                </b>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
      <p className="inner-caption">
        Verified broker performance is shown on Home; broker deal history is
        available in MT5.
      </p>
      {data?.settings ? (
        <section className="inner-card">
          <div className="inner-card-title">
            <span>AUTOMATION RISK SETTINGS</span>
            <span className="inner-tag">BROKER CHECKED</span>
          </div>
          <p>
            Position sizes use the lower of your balance and equity, the
            stop-loss distance and the current adaptive risk percentage. The
            broker&#39;s maximum volume remains a hard cap. Automatic sizing has
            no fixed 0.01-lot ceiling. You can add a smaller custom cap below.
            Orders too small for the broker minimum are skipped. Gaps, fees and
            slippage can exceed estimated stop risk.
          </p>
          <RiskSettingsForm
            key={JSON.stringify(data.settings)}
            settings={data.settings}
            busy={busy}
            action={action}
          />
        </section>
      ) : null}
    </>
  );
}

function RiskSettingsForm({
  settings,
  busy,
  action,
}: {
  settings: TradeSettings;
  busy: boolean;
  action: Action;
}) {
  const [sizingMode, setSizingMode] = useState(
    settings.sizingMode || "adaptive",
  );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        await action({
          action: "settings",
          settings: {
            ...Object.fromEntries(
              fields.map(([key]) => [
                key,
                Number(form.get(key) ?? settings[key]),
              ]),
            ),
            tradingMode: form.get("tradingMode"),
            strategy: form.get("strategy"),
            sizingMode,
          },
        });
      }}
    >
      <label className="trade-field">
        AI strategy
        <select name="strategy" defaultValue={settings.strategy || "adaptive"}>
          <option value="adaptive">Adaptive AI</option>
          <option value="price-action">Price Action</option>
          <option value="scalping">Scalping</option>
        </select>
      </label>
      <label className="trade-field">
        AI trading mode
        <select
          name="tradingMode"
          defaultValue={settings.tradingMode || "balanced"}
        >
          <option value="balanced">Balanced</option>
          <option value="aggressive">Aggressive</option>
        </select>
      </label>
      <p className="inner-caption">
        The selected mode sets the upper risk profile. Market conditions can
        reduce risk or require WAIT in either mode. Scalping is used only when
        spread, volatility and trend checks permit it. Neither mode can override
        safety limits or enable martingale.
      </p>
      <label className="trade-field">
        Position sizing
        <select
          name="sizingMode"
          value={sizingMode}
          onChange={(e) =>
            setSizingMode(e.target.value as TradeSettings["sizingMode"])
          }
        >
          <option value="adaptive">Automatic · adapt to balance</option>
          <option value="capped">Automatic · add a custom lot cap</option>
        </select>
      </label>
      <p className="inner-caption">
        Both options calculate lots from your account funds and stop-risk
        budget. A custom cap can only reduce that size; it cannot increase risk
        or bypass the broker minimum, margin or account limits.
      </p>
      {fields
        .filter(([key]) => key !== "lotSize" || sizingMode === "capped")
        .map(([key, label, min, max, step]) => (
          <label className="trade-field" key={key}>
            {label}
            <input
              name={key}
              type="number"
              required
              min={min}
              max={max}
              step={step}
              defaultValue={settings[key]}
            />
          </label>
        ))}
      <button type="submit" className="action-outline" disabled={busy}>
        Save limits & stop automation
      </button>
    </form>
  );
}
