"use client";
import { useAnalysis } from "../../lib/use-workspace";
import { useAnalysisEngine, engineLabel } from "../../lib/use-analysis-engine";
import { brokerNumber, brokerTime } from "../../lib/use-orders";

export default function AnalysisPanel() {
  const { data, error } = useAnalysis();
  const engine = useAnalysisEngine();
  const result = data?.latest?.result;
  const expired =
    !!result?.expiresAt &&
    !!data?.serverTime &&
    result.expiresAt <= data.serverTime;
  const profile = data?.profile;
  return (
    <section
      className="inner-card"
      id="market-analysis"
      aria-labelledby="market-analysis-title"
    >
      <div className="inner-card-title">
        <span id="market-analysis-title">AI MARKET ANALYSIS</span>
        <span className="inner-tag">
          {engineLabel(engine.data?.state).toUpperCase()}
        </span>
      </div>
      <p>
        {engine.data?.reason ||
          data?.ai.error ||
          "Real MT5 candles, deterministic indicators and OpenAI interpretation."}
      </p>
      {result ? (
        <>
          <div className={`decision decision-${result.decision.toLowerCase()}`}>
            {result.symbol} ·{" "}
            {result.aiDecision ||
              (result.decision === "WAIT" ? "HOLD" : result.decision)}
          </div>
          <p>{result.reasoning}</p>
          <div className="inner-kv">
            <span>Strategy</span>
            <b>{result.strategy}</b>
          </div>
          <div className="inner-kv">
            <span>Signal time</span>
            <b>{brokerTime(result.analyzedAt)}</b>
          </div>
          <div className="inner-kv">
            <span>Signal age</span>
            <b>
              {data?.serverTime
                ? `${Math.max(0, Math.floor((data.serverTime - result.analyzedAt) / 1000))}s`
                : "—"}
            </b>
          </div>
          {result.entryConditions?.length ? (
            <details className="settings-inline-details">
              <summary>Entry conditions</summary>
              {result.entryConditions.map((condition, index) => (
                <p key={index}>{condition}</p>
              ))}
            </details>
          ) : null}
          <p className="inner-caption">
            {!data?.market?.fresh
              ? "Broker data stale · analysis history only."
              : expired
                ? "Expired · analysis history only."
                : "An AI proposal is not a broker-confirmed execution."}
          </p>
          {result.risks?.length ? (
            <details className="settings-inline-details">
              <summary>Risk observations</summary>
              {result.risks.map((risk) => (
                <p key={risk}>{risk}</p>
              ))}
            </details>
          ) : null}
          {result.positionActions?.length ? (
            <details className="settings-inline-details">
              <summary>AI position decisions</summary>
              {result.positionActions.map((action) => (
                <div className="trade-history" key={action.position}>
                  <b>
                    #{action.position} · {action.kind.replaceAll("_", " ")}
                  </b>
                  <p>{action.reasoning}</p>
                </div>
              ))}
            </details>
          ) : null}
        </>
      ) : (
        <p>
          No verified AI decision yet. Analysis initializes after a valid EA
          connection; execution remains separately authorized.
        </p>
      )}
      {profile ? (
        <details className="settings-inline-details">
          <summary>Verified background indicators</summary>
          <div className="inner-kv">
            <span>Market conditions</span>
            <b>{profile.regime}</b>
          </div>
          <p>{profile.scalpingReason}</p>
          {(["M1", "M5", "M15", "H1"] as const).map((frame) => {
            const indicators = profile.frames?.[frame];
            return indicators ? (
              <div className="trade-history" key={frame}>
                <b>
                  {frame} · {indicators.trend?.direction || "Waiting"}
                </b>
                <p>
                  RSI {brokerNumber(indicators.rsi14, 2)} · ATR{" "}
                  {brokerNumber(indicators.atr14)}
                  <br />
                  EMA {brokerNumber(indicators.ema9)} /{" "}
                  {brokerNumber(indicators.ema21)} /{" "}
                  {brokerNumber(indicators.ema50)}
                  <br />
                  MACD {brokerNumber(indicators.macd?.line)} /{" "}
                  {brokerNumber(indicators.macd?.signal)}
                  <br />
                  Support {brokerNumber(indicators.support)} · Resistance{" "}
                  {brokerNumber(indicators.resistance)}
                </p>
              </div>
            ) : null;
          })}
        </details>
      ) : null}
      <details className="settings-inline-details">
        <summary>Recent analysis activity</summary>
        {data?.history?.length ? (
          data.history.slice(0, 8).map((entry) => (
            <div className="trade-history" key={entry.id}>
              <b>
                {entry.result
                  ? `${entry.result.symbol} · ${entry.result.decision}`
                  : entry.status}
              </b>
              <p>
                {entry.result?.reasoning || entry.error || "Analysis pending"}
              </p>
              <small>{brokerTime(entry.createdAt)}</small>
            </div>
          ))
        ) : (
          <p>No recorded analysis cycles.</p>
        )}
      </details>
      {error || engine.error ? (
        <p className="inner-error" role="alert">
          {error || engine.error}
        </p>
      ) : null}
      <p className="inner-caption">
        AI scores are not statistically verified trade probabilities. News is
        used only when a verified news feed is connected. Broker execution
        remains separately authorized.
      </p>
    </section>
  );
}
