# ROCKET1000

Existing Next.js dashboard and MQL5 EA upgraded on `codex/professional-auto-trading-upgrade`. The original dark-purple/pink design, Deadpool assistant, private browser ownership and existing HTTPS MT5 connection are preserved. **Source commit `75af6ce` is deployed at https://rocket1000.vercel.app with Auto Trading OFF.** Software checks and hosted verification pass; genuine paid AI and broker execution still need external acceptance. See the [28 October deployment record](DEPLOYMENT-2026-10-28.md).

**Production now uses engine `rocket-ai-7` / EA 7.00.** Download the matching EA from MT5 and follow [activation readiness](ACTIVATION-READINESS.md). The earlier engine 6 release remains a rollback target. PR #4 is still unmerged.

## Account and execution workflow

1. Configure the paid `OPENAI_API_KEY`, configurable `OPENAI_MODEL`, PostgreSQL database and separate encryption secret on the backend and worker. The header gear opens AI Engine Configuration, with server-managed AI status and a bounded Test Connection action; no browser API-key entry is used by default.
2. Download the verified matching EA package from the private MT5 page after the backend release is approved. Copy its MQL5 folder into the terminal data folder, add the unchanged public HTTPS origin to MT5 WebRequest and attach the EA to the desired broker symbol. The package contains its own restricted installation credential; no OpenAI key or backend master secret is included.
3. MT5 reports the actual Demo/Live type, account, broker, balance/equity/margin, permissions, ticks, prices, completed candles, owned positions and broker results. There is no manual account-type selector.
4. Fresh authenticated EA data automatically initializes analysis through a verified Queue callback or supervised worker. This creates no trading permission. Use **Enable Auto Trading** once for the current account; Live additionally requires the bounded exact-account/current-engine review in the gear drawer. The backend verifies OpenAI, the real scheduler, account/symbol and execution safety. Both account types use the same engine; eligible automatic orders need no individual confirmation.
5. **Stop Auto Trading**, **Pause AI** and the separate **Emergency Stop** persist OFF across restarts and reconnections. Existing positions stay open. An enabled same-account/installation/terminal/engine session can recover after readiness verification and broker reconciliation. Account switching never transfers execution; previously completed Live reviews are retained for their exact account and engine until revoked. The operator `ROCKET_DISABLE_LIVE_ORDERS=1` independently blocks Live execution.

No production execution was activated and no broker orders were placed by this release. Genuine Demo entry, modification and exit remain required acceptance work. Backend and downloadable EA 7 now match; installing/attaching the EA and funding/testing the real API are external setup steps.

## Real data and AI

The official OpenAI SDK uses Responses with strict structured output, bounded timeouts, no SDK retries and no silent model/provider fallback. `OPENAI_MODEL` is server-configurable and must pass a genuine account-access test. Default server-managed mode resolves only the server OpenAI secret/model and disables Gateway fallback. Historical encrypted workspace credential support remains behind the explicit operator-only `ROCKET_OPENAI_SERVER_MANAGED=0` compatibility mode; prior removal tombstones remain effective.

OpenAI interprets authenticated M1/M5/M15/H1 market context and selects Scalping, Trend, Breakout, Reversal or HOLD. BUY/SELL/HOLD/CLOSE output includes conditions, reasoning, confidence and exact-ticket management plans. Symbol and timestamp are revalidated against the broker snapshot. HOLD/CLOSE normalize to the internal no-entry WAIT state; CLOSE still requires a valid owned-ticket close action. The model cannot authorize execution or raise risk limits.

EMA 9/21/50/200, RSI, MACD, ATR, price structure, support/resistance, completed-candle breakout/retest and reversal/sweep observations are calculated deterministically. OpenAI is not called on each tick. Scalping requires suitable verified conditions and costs. Unknown news or liquidity is never invented, and confidence is not presented as a calibrated probability.

Broker SL/TP remain independent protection. AI-authorized MODIFY requests support protective stop tightening, cost-aware breakeven and trailing decisions without widening or removing the stop. Genuine broker fills, partial fills, rejections and reconciled closures remain distinct. No unrestricted model command reaches MT5.

## Dashboard and private reports

Home shows the verified account and three cards: AI Live Analysis, Active Strategy, and Next Signal / Open Orders. The marked standalone Current Position and OpenAI Engine Activity cards are removed. Market retains exact EA-authorized data, owned Open Orders, genuine proposals, AI analysis and verified history. MT5 retains provisioning and authenticated broker data. Bottom navigation contains Home, Market and MT5. The header gear opens the single diagnostics drawer; `/settings` redirects there. Manual sizing/strategy/cost controls are absent from the main screens; administrator safety caps stay enforced server-side. Emergency Stop remains visible while scrolling and inside the open drawer.

The chart uses only fresh, installation/account/session-bound EA OHLC; it withholds candles when verification or freshness fails. No external market watchlist or third-party chart feed is used. Copy report and authenticated CSV/JSON downloads contain explicitly allowlisted broker data with CSV formula protection. No public share link or secret-bearing URL is created. Reports identify their limited history sample and are not complete broker statements.

Updates use bounded authenticated polling, appropriate to the existing Vercel hosting. No permanent WebSocket/serverless trading process is claimed. The app is a responsive installable web application; no native Android APK is fabricated. See [installation and Android instructions](INSTALLATION.md).

## Risk and durability

Hard maximums: **0.25% risk per trade**, **0.25% aggregate open risk**, **1% daily loss including floating loss**, **5% drawdown**, **one concurrent account position**, and pause after three confirmed consecutive losses. Lower per-trade, aggregate, daily-loss and drawdown limits can be saved. No martingale, grid, averaging down or additions are allowed. Position size is rounded down from actual equity/balance, remaining risk capacity, broker tick value, protective stop distance and verified costs. Skip when minimum lot exceeds the budget. All entries require at least 1.5:1 net reward/risk after cost allowances.

Backend and EA independently enforce fresh data, permissions, ownership, volume/tick/stop/freeze restrictions, margin, session and spread limits. Cursor claims, command leases and account/session/run generations prevent duplicate orders and stale asynchronous results. Restart reconciliation never fabricates a fill or closes another EA's/manual position.

Production scheduling uses the existing Vercel Queue callbacks and shared PostgreSQL; a supervised Node worker or protected operator scheduler are alternatives. Actual check-ins are required. Explicit ON intent persists securely, readiness failures back off, and STOP cannot be rearmed by a heartbeat. Daily app-enforced usage reservations, per-bar reuse, configurable frequency and estimated cost tracking bound this app's paid requests. Estimates are not a provider invoice or a guarantee about the same key's use elsewhere. See [operator setup](OPERATIONS.md).

## Development and verification

Use Node 22.16+, `npm ci`, private server environment settings and `npm run db:migrate`. Run `npm run dev` plus `npm run worker:analysis` for local development; production workers require shared PostgreSQL. Checks are `npm test`, `npm run test:http`, `npm run lint`, `npx tsc --noEmit`, `npm run build` and Windows `npm run build:ea` with official MetaEditor.

Actual checks, changed files and external acceptance blockers are recorded in [the upgrade verification report](UNIFIED-UPGRADE-VERIFICATION.md). The draft PR remains unmerged and automatic Git deployment is disabled on this review branch. Deployment and production execution need owner approval. See the historical [previous release report](UPGRADE-VERIFICATION.md) for the older deployed release only.
