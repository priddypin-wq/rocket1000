# ROCKET1000 unified upgrade verification

**Deployment update — 27 October 2026:** Approved source commit `4386d65` is now deployed at https://rocket1000.vercel.app with Auto Trading OFF. Staged and public production checks passed; the real OpenAI diagnostic still reports `AI_BILLING_REQUIRED`. See [the deployment record](DEPLOYMENT-2026-10-27.md). The review results below retain their predeployment context; genuine Demo order execution remains unverified.

Date: 26 October 2026 (Africa/Johannesburg). Repository: priddypin-wq/rocket1000. Branch: codex/professional-auto-trading-upgrade. Review: https://github.com/priddypin-wq/rocket1000/pull/4.

## Delivery boundary

The existing Next.js application, MQL5 source, routes, credential provisioning, AI integration, risk engine, worker and broker reconciliation were inspected and upgraded in place. The original ROCKET1000 branding, Deadpool, private browser ownership and HTTPS MT5 origin remain. The owner-approved source is now deployed with trading OFF; this PR remains unmerged and genuine broker acceptance is still required. No Live development trades or production execution were activated.

The previously approved engine 5 release is the prior rollback target; engine 6 now serves https://rocket1000.vercel.app. On 25 October the actual installed generic EA had no personalized configuration in its exact terminal Files folder. Installing the authenticated production package's configuration repaired its real connection without changing the backend origin or binary. The private production source also compiled successfully. That historical engine 5 authentication check is distinct from the new engine 6 acceptance work.

## Implemented behavior

- Fresh installations default to Auto Trading OFF. START AUTO TRADING on Home is the explicit ON action for either automatically detected Demo or Live. There are no per-order dialogs for eligible AI commands. Same-account recovery and verified account changes can resume a securely persisted ON intent, but never inherit old commands or clear an explicit Stop/Emergency Stop.
- The backend uses the official OpenAI SDK 7.43.0 and Responses API. The model is server-configurable. Default managed mode reads only the server OPENAI_API_KEY/OPENAI_MODEL, disables Gateway fallback and rejects browser credential mutations. Settings exposes connection metadata and Test Connection, not a key field. Historical encrypted workspace keys require an explicit operator compatibility setting and cannot silently override the environment. Prior Remove tombstones remain effective.
- Strict output supports BUY/SELL/HOLD/CLOSE plus exact-ticket KEEP/MODIFY/PARTIAL_CLOSE/CLOSE plans, strategy, conditions, confidence and explanation. Snapshot symbol/timestamp are checked; HOLD/CLOSE use the internal no-entry WAIT representation. A close requires an explicit verified owned-ticket action. Server secret/model rotation fences in-flight analysis and execution without exposing its internal revision.
- Actual closed M1/M5/M15/H1 data supports deterministic EMA9/21/50/200, RSI, MACD, ATR, volatility, price structure, support/resistance, sweeps, breakout/retest and reversal eligibility. OpenAI chooses the strategy; deterministic eligibility is not an independent signal. No paid request is made on each tick, no news feed is invented, and confidence is not a calibrated success probability.
- The EA is a broker-data and authorized execution bridge. It reports actual account mode, balance, equity, margin/free margin, floating P/L, broker counts/permissions, exact symbols, ticks, OHLC, positions, pending orders and broker history/results. It checks stops, freeze levels, volume increments, tick value, margin, spread, fresh quotes, ownership and scoped command authorization before native execution.
- Real broker SL/TP remain independent. AI-authorized protective MODIFY requests support breakeven/trailing decisions without widening/removing stops. OPEN, MODIFY, partial/full CLOSE, acceptance, fills, partial fills, rejection and uncertain/reconciled outcomes remain separate audited states. No manually opened or unrelated-EA position is managed.
- Hard ceilings are 0.25% per trade, 0.25% aggregate risk, 1% daily loss including floating losses, 5% drawdown and one position, with a pause after three confirmed losses. Users may lower risk/aggregate/daily/drawdown limits. Sizing rounds down from actual equity/balance and remaining aggregate capacity, stop distance and verified broker costs. Minimum lots exceeding the budget are skipped. No martingale, grid, additions or averaging down. All entries require at least 1.5:1 net reward/risk after allowances.
- Vercel Queue callbacks and PostgreSQL persist run identity, work claims, activation leases, failure backoff, budgets and liveness independently of the browser. Supervised worker/protected scheduler alternatives remain available. Repeated heartbeats cannot create duplicate starts or repeated paid probes. STOP/Emergency Stop survive restart/reconnect/account switching, including legacy stop aliases.
- Market now includes the requested chart using only fresh exact-symbol/account/installation/session-bound EA candles, plus owned positions, proposals and real history. No fabricated current candle, unrelated watchlist or external chart feed is introduced. Chart geometry preserves reported gaps and prices. Copy report and private CSV/JSON downloads use explicit allowlists, no-store responses, private cookies and CSV formula protection; no public sharing URL is created.
- EA downloads now reuse the same encrypted installation credential. Validated legacy telemetry can backfill its own vault entry. Missing legacy recoverable material requires explicit replacement, rather than silently revoking a working terminal. The actual compiled artifact is verified before download; the private personalized source remains an optional MetaEditor alternative.

## Actual verification results

| Check                                               | Result                               | Evidence / scope                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Node test suite                                | PASS: 405 tests, zero failed/skipped | work/unified-unit-final.log; actual service/transport fixtures only, no provider/broker network calls                                                                                                   |
| HTTP integration                                    | PASS: 56 checks                      | work/unified-http.log; real local Next routes with isolated SQLite, fixture HTTPS host/telemetry, provider credentials explicitly blanked                                                               |
| Next production build                               | PASS                                 | work/unified-build.log; includes private reports, current routes, manifest/icon                                                                                                                         |
| TypeScript                                          | PASS                                 | production build type check and separate tsc --noEmit                                                                                                                                                   |
| ESLint                                              | PASS, zero warnings                  | work/unified-lint.log                                                                                                                                                                                   |
| Generic EA 6.00 compilation                         | PASS: zero errors, zero warnings     | Official MetaEditor; fresh binary, source/binary manifest hashes                                                                                                                                        |
| Personalized EA 6.00 compilation                    | PASS: zero errors, zero warnings     | Private review source/binary outside Git; existing scoped credential; not installed/run                                                                                                                 |
| Production-compatible personalized EA 5 compilation | PASS: zero errors, zero warnings     | Private authentication repair artifact; not the new engine release                                                                                                                                      |
| Frontend known-secret scan                          | PASS                                 | 16 static build artifacts checked against two available known private values; no match. This does not claim access to all production secrets.                                                           |
| Actual existing MT5 authentication                  | VERIFIED on 25 October               | Production owner dashboard and native Experts log showed Connected after missing configuration repair; Algo Trading remained off                                                                        |
| Genuine paid AI / Demo broker order cycle           | BLOCKED / UNVERIFIED                 | Last real provider test on 25 October returned AI_BILLING_REQUIRED; broker quotes were stale. No later success inferred.                                                                                |
| Final Android/browser chart visual QA               | UNVERIFIED                           | Earlier responsive checks predated the final chart/settings changes; current build and data/provenance tests pass, but browser control became unavailable. No native Android hardware test/APK claimed. |

EA artifact source SHA-256: 1b4da565639cfe9cff6ff96a645aec737093b662c2001eebdea462477ec28da4.

EA artifact binary SHA-256: 82c9187f5145e0fb4f3f7804952fa074d3f8ce40d3e25e2966f2eb5133e755ac. Compilation time: 2026-10-26T09:13:53.9367036Z.

Regression coverage includes explicit ON default, both account types, same-terminal recovery, account switches, stopped-state migration, Stop during async verification, server key rotation during paid work, model/risk/schema failures, budget exhaustion, duplicate callbacks/orders, broker ownership/history reconciliation, private symbol/report isolation, stale/corrupt candles and CSV formula injection. These tests do not establish profitability or genuine broker acceptance.

The dependency update pinned transitive Zod to patched 4.6.7 after the initial advisory check. Subsequent full registry audit requests failed with ECONNRESET, so a fresh complete dependency-audit result is unavailable; zero vulnerabilities is not claimed.

## Remaining acceptance and operator requirements

1. The matching backend and EA 6 download were approved and deployed on 27 October, preserving the existing project/origin/database/credentials. Install that matching EA on the terminal for genuine Demo acceptance. Trading remains OFF; deployment did not attach an EA or authorize broker execution.
2. Verify funded OpenAI access and the configured model through the backend's real Test Connection. Keys/payment details stay in the provider/hosting settings. A successful fixed connection test does not itself prove a valid trade decision.
3. Connect an authorized Demo terminal with fresh data and suitable risk conditions, then explicitly enable Auto Trading for the acceptance test. Observe real AI → approved command → EA → broker OPEN, protective management, CLOSE and final tickets/history. Do not bypass existing exposure, broker permissions, stale-data or loss limits merely to force a test.
4. Complete historical tick/cost, out-of-sample, walk-forward and Demo-forward validation. Win rate, profit factor, expectancy, drawdown, reversal performance and execution quality are not fabricated or claimed verified.
5. Complete final browser/Android review and, if a native store APK is required, provide an approved Android packaging project/toolchain/package identity/signing setup. The repository currently builds an installable responsive web app, not a native APK.
6. Retry the dependency advisory audit when the registry endpoint is reachable. Supervise the EA host and keep backend/worker configuration identical. This Vercel architecture uses authenticated bounded polling rather than claiming a permanent WebSocket/serverless trading process.

Manual Close Position remains ownership/account scoped and requires a fresh authorized review; when the application cannot verify execution authorization, manage positions directly in MT5. Emergency Stop leaves positions open and cannot recall an order already sent to a broker.

## Controls and installation

Home: START/STOP AUTO TRADING and separate Emergency Stop. Settings: server AI connection/Test Connection, lower risk limits, cost controls and Emergency Stop. Market: real EA symbol/candles, Open Orders with reviewed Close action, proposals/history, Copy report/Download CSV. MT5: authenticated compiled download, Copy EA Connection URL, detected account and broker diagnostics.

See INSTALLATION.md for server/worker, terminal, MetaEditor and Android web installation instructions. See OPERATIONS.md for the existing production target and rollback boundary. The draft PR remains unmerged.

## Changed repository files

Paths below are relative to this existing repository; private configuration/source repair artifacts and work logs are deliberately outside the published change.

```text
.env.example
INSTALLATION.md
OPERATIONS.md
README.md
UNIFIED-UPGRADE-VERIFICATION.md
app/api/ea/register/route.ts
app/api/mt5/download/route.ts
app/api/mt5/openai/route.ts
app/api/mt5/reports/route.ts
app/api/mt5/scalping/route.ts
app/components/analysis-panel.tsx
app/components/broker-chart.module.css
app/components/broker-chart.tsx
app/components/live-activation.tsx
app/components/mt5-connection.tsx
app/components/openai-connection.tsx
app/components/robot-home.tsx
app/components/trade-controls.tsx
app/components/trading-dashboard.tsx
app/icon.tsx
app/layout.tsx
app/manifest.ts
app/robot-home.css
app/settings/page.tsx
ea/ROCKET1000_EA.ex5
ea/ROCKET1000_EA.mq5
ea/build-manifest.json
lib/broker-chart.d.mts
lib/broker-chart.mjs
lib/engine-version.mjs
lib/mt5-client.ts
lib/private-report-types.ts
lib/risk.mjs
lib/trading-types.ts
lib/use-orders.ts
lib/use-scalping.ts
lib/use-workspace.ts
package-lock.json
package.json
scripts/analysis-worker.mjs
scripts/test-http.mjs
server/ai-analysis.mjs
server/ai-usage.mjs
server/analysis-queue.mjs
server/automation.mjs
server/autonomous-status.mjs
server/database.mjs
server/ea-credential-vault.mjs
server/ea-source.mjs
server/engine-activation.mjs
server/engine-service.mjs
server/http.mjs
server/market.mjs
server/openai-credentials.mjs
server/orders-dashboard.mjs
server/provisioning.mjs
server/report-export.mjs
server/strategy.mjs
server/trade-settings.mjs
server/trading.mjs
tests/ai-decision-context.test.mjs
tests/analysis-engine.test.mjs
tests/analysis.test.mjs
tests/automation.test.mjs
tests/autonomous-status.test.mjs
tests/broker-reports.test.mjs
tests/demo-validation.test.mjs
tests/ea-autostart.test.mjs
tests/ea-credential-vault.test.mjs
tests/ea-professional.test.mjs
tests/engine-upgrade.test.mjs
tests/helpers.mjs
tests/live-activation.test.mjs
tests/market-features.test.mjs
tests/mode-risk.test.mjs
tests/openai-credentials.test.mjs
tests/orders-dashboard.test.mjs
tests/provisioning.test.mjs
tests/risk.test.mjs
tests/scalping-direction.test.mjs
tests/server-managed-ai.test.mjs
tests/settings-account-safety.test.mjs
tests/signals-v3.test.mjs
tests/strategy.test.mjs
tests/trading.test.mjs
tests/unified-authorization.test.mjs
tests/winning-additions.test.mjs
```
