"use client";
export type BrokerPosition = {
  ticket?: string;
  identifier?: string;
  symbol: string;
  side: string;
  volume: number;
  open: number;
  stop: number;
  takeProfit: number;
  profit: number;
  managed: boolean;
};
export default function PositionControls({
  positions,
  available,
  busy,
  permitted,
  onReview,
}: {
  positions: BrokerPosition[];
  available: boolean;
  busy: boolean;
  permitted: boolean;
  onReview: (order: unknown) => Promise<void>;
}) {
  return (
    <section className="inner-card">
      <div className="inner-card-title">
        <span>ACTUAL BROKER POSITIONS</span>
        <span className="inner-tag">{available ? positions.length : "—"}</span>
      </div>
      {!available ? (
        <p role="status">Waiting for fresh MT5 position data.</p>
      ) : positions.length ? (
        positions.map((p, i) => (
          <div key={p.ticket || i} className="trade-history">
            <b>
              {p.symbol} · {p.side} · {p.volume} lots
            </b>
            <div className="inner-kv">
              <span>Floating P/L</span>
              <b>{p.profit.toFixed(2)}</b>
            </div>
            <p>
              SL {p.stop || "Missing"} · TP {p.takeProfit || "Missing"} ·{" "}
              {p.managed
                ? "Opened by this connection"
                : "External position — automatic management excluded"}
            </p>
            {p.managed ? (
              <>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!available || !permitted || busy) return;
                    const values = new FormData(e.currentTarget);
                    await onReview({
                      kind: "MODIFY",
                      position: p.ticket,
                      stop: Number(values.get("stop")),
                      takeProfit: Number(values.get("takeProfit")),
                    });
                  }}
                  key={`${p.ticket}:${p.stop}:${p.takeProfit}`}
                >
                  <label className="trade-field">
                    New protective stop
                    <input
                      name="stop"
                      type="number"
                      required
                      min="0.00000001"
                      step="any"
                      defaultValue={p.stop || ""}
                    />
                  </label>
                  <label className="trade-field">
                    Take-profit
                    <input
                      name="takeProfit"
                      type="number"
                      required
                      min="0.00000001"
                      step="any"
                      defaultValue={p.takeProfit || ""}
                    />
                  </label>
                  <button
                    className="action-outline"
                    type="submit"
                    disabled={busy || !permitted || !available}
                  >
                    Review modification
                  </button>
                </form>
                <button
                  className="action-outline"
                  disabled={busy || !permitted || !available}
                  onClick={() =>
                    void onReview({ kind: "CLOSE", position: p.ticket })
                  }
                >
                  Review close
                </button>
              </>
            ) : null}
          </div>
        ))
      ) : (
        <p>No positions reported by MT5.</p>
      )}
    </section>
  );
}
