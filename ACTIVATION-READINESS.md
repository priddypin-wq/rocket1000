# ROCKET1000 activation readiness

28 October 2026, Africa/Johannesburg. Existing project and production origin: `priddypin-wq/rocket1000`, draft PR #4, `https://rocket1000.vercel.app`. The software is prepared for external activation; genuine paid-provider and broker qualification are separate and must not be inferred from mocks or a successful web deployment.

## Completed application code

- The official OpenAI SDK calls the Responses API with a strict JSON schema, server-only key/model resolution, bounded timeouts, sanitised errors, per-bar reuse, usage reservations and app-enforced cost limits. Models are configurable and account access must pass a genuine test. No Gateway success or paid API availability is invented. The request format was checked against [official Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs).
- Authenticated native EA telemetry supplies exact broker symbols, quotes, completed M1/M5/M15/H1 candles, account type from `ACCOUNT_TRADE_MODE`, financials, execution permissions, owned positions and broker results. The scoped installation credential and canonical HTTPS backend are preserved. Repeat downloads reuse the credential; the verified compiled package and personalized source remain private.
- Price-action/indicator calculations and strategy eligibility run deterministically; OpenAI interprets market conditions and proposes entry/management decisions. HOLD/WAIT never opens a position. Proposal acceptance, sending, broker fill, partial execution, rejection and position reconciliation remain separate audited states.
- Both Demo and Live use the same engine. Fresh data can start analysis automatically through the actual Vercel Queue or supervised worker. Explicit per-account execution authorization is required, with a bounded exact-account/current-engine Live review. Reconnect can resume a valid enabled session; Stop, Pause AI, Emergency Stop, account/terminal/version changes and the operator Live switch remain independent fences.
- Adaptive position sizing preserves fixed hard ceilings and lower saved caps, rounds down to broker steps, includes verified costs/slippage and skips unsafe minimum lots. Native `OrderCalcProfit`, `OrderCalcMargin`, `OrderCheck`, broker stops and execution constraints independently protect the final boundary. No martingale, grid, averaging down or unrestricted stacking is implemented.
- Existing automatic entry, protective modification, partial/full close and ownership/reconciliation functionality is retained. It is covered by controlled service/HTTP fixtures, not presented as proven broker execution. The EA has no independent strategy that invents entries or discretionary exits.
- Home uses three concise sections, the original dark design/Deadpool, authenticated account data, analysis/execution controls and a reachable Emergency Stop. Home/Market/MT5 are the only bottom tabs. The gear opens one diagnostics drawer; technical controls are hidden from the main interface. Both selected redundant Home cards are removed.

## Final release repairs

Worker discovery now persists its last-checked ordering, so already-healthy early workspaces cannot starve later connections. A multi-workspace test recreates the worker facade between checks and verifies that analysis starts for all eligible accounts without granting execution.

`scripts/release-safety.mjs` is an explicit release operation. It latches analysis/execution OFF, cancels queued work, preserves installation credentials and prints only aggregate safety evidence. Claimed/sending broker outcomes block promotion; historical uncertain outcomes remain unresolved and continue to block execution. A release cannot manufacture acknowledgements or close positions to pass a check.

## Verification scope

Current unit/service suite: **451 passed**, zero failures/skips. TypeScript, zero-warning ESLint and the Next.js production build pass. Official MetaEditor freshly compiled EA 7.00 with **zero errors and warnings**; SHA-256 values are in `ea/build-manifest.json`. The source is unchanged from the previously reviewed EA 7; the new binary has a fresh build timestamp.

Responsive browser checks pass at Android-sized 390×844 and desktop 1280×900, with 12 checks covering navigation, removed cards, drawer/Escape, visible Emergency Stop, no main manual fields, no horizontal overflow and no uncaught runtime errors. This is browser emulation, not a physical Android device or native APK acceptance test.

All **56 HTTP integration checks passed** against actual local Next routes, secure sessions, downloads and fixture telemetry. Hosted release results will be recorded separately once completed. Local fixtures never call a broker or paid provider and are isolated from production databases. No real broker order or Live activation is permitted during this release.

## External activation and acceptance

1. **OpenAI:** a server API key already exists in the selected Vercel project, but the last genuine test reported `AI_BILLING_REQUIRED`. Funding that same API project does not require application code changes. After funding, use the header gear → OpenAI AI Connection → Test Connection. Replacing a secret/model later follows Vercel's normal environment/redeployment workflow; never paste it into the EA, public URL or chat.
2. **MT5 host:** install the matching downloaded EA 7 and bundled private configuration after its backend is released, whitelist the unchanged HTTPS URL, attach to the exact broker symbol and keep the Windows/VPS terminal connected. These terminal installation/permission steps cannot be performed by an Android webpage. The dashboard must show genuine account, market freshness and broker readiness.
3. **Demo qualification:** separately authorize a controlled genuine Demo run. Verify actual entry and protective SL/TP, modification, partial/rejected execution where available, exit, broker history, restart recovery, idempotency and risk blocks. Preserve preexisting positions; report any blocked test instead of bypassing risk protections. No such broker tests were run during this task.
4. **Live review:** only after Demo qualification, separately review the exact Live account, engine, broker permissions, risk checks and operator safety switch. This release does not grant Live authorization, remove the operator switch or enable execution. There is no per-order confirmation once an eligible session is explicitly authorized.

No fabricated balances, prices, signals, profits or trade confirmations are displayed. No guarantee of profitability, completed backtest, physical Android test, native APK build or genuine AI-to-broker cycle is claimed. See `ADAPTIVE-UPGRADE-VERIFICATION.md` for the prior implementation details and all changed files; the release record identifies the exact deployed source and real hosted checks.
