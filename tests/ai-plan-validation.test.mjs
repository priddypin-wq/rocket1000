import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAssessment } from "../server/ai-analysis.mjs";
import { adaptiveProfile } from "../server/market.mjs";
import { orderRisk } from "../server/trading.mjs";
import { defaultTradeSettings } from "../server/trade-settings.mjs";
import { market, decision, NOW } from "./helpers.mjs";

const m = market();
const owned = {
  managed: true,
  symbol: m.symbol,
  ticket: "123",
  identifier: "456",
  side: "BUY",
  volume: 0.03,
  open: 2098,
  stop: 2090,
  takeProfit: 2120,
};
const wait = {
  ...decision,
  confidence: 0.95,
  entryAction: "NONE",
  proposedLots: null,
  positionActions: [],
};
const action = {
  kind: "MODIFY",
  position: "123",
  volume: null,
  stopLoss: 2098,
  takeProfit: 2120,
  reasoning: "AI proposes break-even protection.",
};
test("AI plans can manage only verified owned tickets, cannot loosen protection and never turn WAIT into an entry", () => {
  const p = adaptiveProfile(m);
  assert.doesNotThrow(() =>
    validateAssessment({ ...wait, positionActions: [action] }, m, p, [owned]),
  );
  for (const patch of [
    { entryAction: "OPEN", proposedLots: 0.01 },
    { proposedLots: 0.01 },
    { positionActions: [{ ...action, position: "789" }] },
    { positionActions: [action, action] },
    { positionActions: [{ ...action, stopLoss: 2089 }] },
    {
      positionActions: [
        {
          ...action,
          kind: "PARTIAL_CLOSE",
          volume: 0.04,
          stopLoss: null,
          takeProfit: null,
        },
      ],
    },
    {
      positionActions: [
        {
          ...action,
          kind: "CLOSE",
          volume: 0.01,
          stopLoss: null,
          takeProfit: null,
        },
      ],
    },
    { positionActions: [{ ...action, kind: "UNRESTRICTED_COMMAND" }] },
  ])
    assert.throws(
      () => validateAssessment({ ...wait, ...patch }, m, p, [owned]),
      (e) => e.code === "AI_INVALID_RESPONSE",
    );
  assert.throws(() =>
    validateAssessment({ ...wait, positionActions: [action] }, m, p, [
      { ...owned, managed: false },
    ]),
  );
  assert.doesNotThrow(() =>
    validateAssessment(
      {
        ...wait,
        positionActions: [
          {
            ...action,
            kind: "PARTIAL_CLOSE",
            volume: 0.01,
            stopLoss: null,
            takeProfit: null,
          },
        ],
      },
      m,
      p,
      [owned],
    ),
  );
});

test("partial closes preserve broker minimums, step sizes, exact position volume and separate user permission", () => {
  const ctx = {
    now: NOW,
    market: { ...m, positions: [owned] },
    execution: {
      protocol: 4,
      point: 0.01,
      tickSize: 0.01,
      minVolume: 0.01,
      maxVolume: 10,
      volumeStep: 0.01,
      stopLevel: 10,
    },
    settings: defaultTradeSettings,
    permissionActive: true,
    connectionBlockers: [],
    unresolved: null,
    revision: "fixture",
  };
  const request = {
    kind: "CLOSE",
    position: owned.ticket,
    partialClose: true,
    volume: 0.01,
  };
  const valid = orderRisk(ctx, request);
  assert.equal(valid.volume, 0.01);
  assert.equal(valid.positionVolume, 0.03);
  assert.equal(valid.partialClose, true);
  for (const volume of [0, -0.01, 0.005, 0.025, 0.03, 0.04, NaN])
    assert.throws(
      () => orderRisk(ctx, { ...request, volume }),
      /Partial close/,
    );
  assert.throws(
    () => orderRisk(ctx, { ...request, positionVolume: 0.04 }),
    /volume changed/,
  );
  assert.throws(
    () => orderRisk({ ...ctx, permissionActive: false }, request),
    /permission/,
  );
  assert.throws(
    () =>
      orderRisk(
        {
          ...ctx,
          market: { ...ctx.market, positions: [{ ...owned, managed: false }] },
        },
        request,
      ),
    /verified ownership/,
  );
  assert.equal(
    orderRisk(ctx, { kind: "CLOSE", position: owned.ticket }).volume,
    0.03,
    "full close still requests the exact broker position volume",
  );
});
