import { test } from "node:test";
import assert from "node:assert/strict";
import { market, decision, NOW } from "./helpers.mjs";
import { adaptiveProfile } from "../server/market.mjs";
import { validateAssessment } from "../server/ai-analysis.mjs";

const snapshot = market();
const profile = adaptiveProfile(snapshot);
const hold = {
  ...decision,
  decision: "HOLD",
  strategy: "wait",
  entryPrice: null,
  stopLoss: null,
  takeProfit: null,
  proposedLots: null,
  entryAction: "NONE",
  positionActions: [],
  symbol: snapshot.symbol,
  timestamp: snapshot.timestamp,
  entryConditions: ["No completed entry confirmation in this fixture."],
};

test("HOLD is explicitly no-entry and bound to the actual symbol and snapshot timestamp", () => {
  const result = validateAssessment(hold, snapshot, profile);
  assert.equal(result.decision, "WAIT");
  assert.equal(result.aiDecision, "HOLD");
  assert.equal(result.timestamp, NOW);
  for (const patch of [
    { symbol: "EURUSD" },
    { timestamp: NOW - 1 },
    { entryConditions: [" "] },
    { entryConditions: ["x".repeat(601)] },
    { entryAction: "OPEN", proposedLots: 0.01 },
  ])
    assert.throws(
      () => validateAssessment({ ...hold, ...patch }, snapshot, profile),
      (e) => e.code === "AI_INVALID_RESPONSE",
    );
});

test("CLOSE cannot imply an entry, invent ownership or omit an exact-ticket close plan", () => {
  const owned = {
    ticket: "123",
    identifier: "123",
    symbol: snapshot.symbol,
    side: "BUY",
    volume: 0.03,
    open: 2090,
    stop: 2085,
    takeProfit: 2120,
    managed: true,
  };
  const close = {
    ...hold,
    decision: "CLOSE",
    positionActions: [
      {
        kind: "CLOSE",
        position: "123",
        volume: null,
        stopLoss: null,
        takeProfit: null,
        reasoning: "Fixture confirmed invalidation.",
      },
    ],
  };
  const result = validateAssessment(close, snapshot, profile, [owned]);
  assert.equal(result.aiDecision, "CLOSE");
  assert.equal(result.decision, "WAIT");
  assert.equal(result.positionActions[0].position, "123");
  for (const patch of [
    { positionActions: [] },
    { proposedLots: 0.01 },
    { positionActions: [{ ...close.positionActions[0], position: "999" }] },
  ])
    assert.throws(() =>
      validateAssessment({ ...close, ...patch }, snapshot, profile, [owned]),
    );
  assert.throws(() =>
    validateAssessment(close, snapshot, profile, [
      { ...owned, managed: false },
    ]),
  );
});
