# ROCKET1000 installation and acceptance

This is the existing responsive Next.js application and native MT5 Expert Advisor. The Android device is the monitoring/control interface. MT5 and the EA must remain running on a connected Windows computer or Windows VPS; installing the dashboard on Android does not run the EA there.

## Server and worker

The current review upgrade is engine `rocket-ai-7` / EA 7.00, not deployed. The public app still uses the approved engine 6 release. Do not install EA 7 against the old backend or change the production Live-order disable switch during review. See [current verification and qualification requirements](ADAPTIVE-UPGRADE-VERIFICATION.md).

1. Use the existing ROCKET1000 Vercel project and HTTPS hostname. Do not create a duplicate project or change the installed EA's backend origin.
2. Keep `DATABASE_URL`, `ROCKET_DASHBOARD_URL` and `ROCKET_BACKEND_URL` private server configuration. Production uses shared PostgreSQL, not local serverless SQLite.
3. Configure `OPENAI_API_KEY` as a server secret and `OPENAI_MODEL` as an account-accessible Responses model. Keep `ROCKET_OPENAI_SERVER_MANAGED=1`. Never prefix secrets with `NEXT_PUBLIC_`. A successful real connection test, available billing and reviewed token pricing are required; model availability is not assumed.
4. Retain `ROCKET_OPENAI_ENCRYPTION_KEY`, a separate canonical base64 32-byte secret, for authenticated encrypted credential storage. Keep it outside the database and source repository. Do not replace it casually: old installation vaults would become unreadable.
5. Back up the existing database before an approved release. Run `npm ci`, `npm run db:migrate`, then `npm run build`. This branch disables automatic Git deployment and must not be merged/deployed without owner approval.
6. Use the existing Vercel Queue trigger with `ROCKET_QUEUE_ANALYSIS=1`, or run `npm run worker:analysis` as a supervised persistent service with the same database, secrets, model and pricing. The app requires a genuine scheduler check-in. A bounded function or browser tab is not a permanent worker. The optional protected scheduler endpoint requires its own operator-managed `CRON_SECRET` and an actual schedule.

See `.env.example` for names/placeholders and `OPERATIONS.md` for the existing target, rollback boundary and queue details. Never paste database passwords or API keys into a support conversation.

## MT5 installation

1. After the matching backend release has been approved, open the existing private MT5 page in the browser that owns the connection. Download Rocket1000 EA. The ZIP must contain the verified real `.ex5`, personalized configuration and instructions. If the compiled hash does not match the build manifest, download stays unavailable.
2. In MT5 choose File → Open Data Folder. Extract the ZIP and copy its `MQL5` folder into that data folder, merging Experts and Files. Keep the configuration at `MQL5/Files/ROCKET1000/rocket1000.config`.
3. Use Copy EA Connection URL. Paste only that public HTTPS origin into Tools → Options → Expert Advisors → Allow WebRequest. The public URL contains no connection token or OpenAI key.
4. Sign into the desired broker account inside MT5. Attach ROCKET1000 EA to the broker symbol to be analyzed, preserving suffixes such as `XAUUSDm`. Account type is detected from `ACCOUNT_TRADE_MODE`; do not choose Demo/Live manually.
5. Keep Algo Trading OFF during the initial connection check. Confirm the app reports the actual broker, account, recent heartbeat and current EA version. A Connected heartbeat with stale quotes is not execution readiness.
6. For a separately authorized **Demo acceptance test**, enable the EA and terminal Algo Trading permissions, verify OpenAI using the header gear → Test Connection, then use **Enable Auto Trading** on Home. Fresh connections may analyze automatically but do not execute. This is the explicit ON authorization for execution. Every order still needs a valid AI decision and independent server/native risk approval. No per-order dialog is shown for eligible automatic commands. This development task does not authorize broker tests or orders.
7. Stop Auto Trading or Emergency Stop persists OFF. It does not close existing positions. A separately reviewed manual Close Position uses its own bounded ticket/account confirmation. Broker SL/TP remain independent protections.

The same source and execution pipeline support Live. The header gear → Trading authorization & verification prepares a short-lived review for the exact Live account and engine; confirmation saves approval without starting orders. Enable Auto Trading remains a separate action. Keep `ROCKET_DISABLE_LIVE_ORDERS` unchanged until a separately authorized Live-readiness review after genuine Demo qualification. Same-account recovery requires prior enabled intent, the same installation/terminal/engine, fresh data, provider/scheduler readiness and no uncertain broker commands. Stop and Emergency Stop never clear on reconnection. A different account never inherits execution permission.

### MetaEditor alternative

The private installation tools also provide a personalized `.mq5` with its restricted credential embedded. Keep it private, open it using MetaEditor, save under the intended Experts folder and press F7 to compile. A website cannot guarantee the laptop's `.mq5` file association or automatically attach an EA to a chart. The bundled compiled package is the primary installation method. Never put the private personalized source in GitHub.

Updating requires the matching backend and EA engine version. The approved engine 6 backend is now deployed with Auto Trading OFF; use its matching EA 6 download for the next Demo acceptance test. Normal downloads preserve an active credential; a legacy installation without recoverable encrypted download material asks for explicit credential replacement rather than silently breaking the current terminal. See [the deployment record](DEPLOYMENT-2026-10-27.md) for the current API billing blocker and checks still required.

## Android and desktop interface

After an approved HTTPS release, open the existing app in Android Chrome and use its Install app / Add to Home screen menu if offered. The repository supplies the web manifest, icon and standalone display metadata. Use the same browser profile/private workspace that owns the MT5 connection; another browser does not inherit its credentials. Preserve browser storage to retain that private ownership session.

Web build commands are `npm ci` and `npm run build`; `npm start` serves the built application. Home, Market, MT5 and Settings are responsive. Updates use authenticated bounded polling; this hosting configuration does not claim a permanent WebSocket service or offline trading. Copy report and CSV/JSON exports require the private browser session. Their URLs are not public sharing links.

There is no native Android/Gradle project in this repository and no APK build is claimed. Producing a signed store APK additionally needs an approved Android packaging project, Android SDK/JDK, package identity, signing keystore and verified HTTPS ownership. Do not package broker credentials or an OpenAI secret in that artifact.

## Required acceptance checks

- Verify actual Demo authentication and fresh current quotes; stale data must block new orders.
- Verify the genuine paid Responses test, usage accounting, budget stop and error reporting.
- Confirm explicit ON is required; restart/connection alone cannot activate a new installation. Verify STOP and Emergency Stop remain latched after reconnect/account switch.
- Observe one genuine Demo entry, protective modification/exit, broker ticket/fill/partial/rejection reporting and final reconciliation. Unit/HTTP fixtures are not broker acceptance evidence.
- Verify order retry deduplication and ownership boundaries; do not manage manual/unrelated EA trades.
- Confirm chart data comes from the authenticated EA and disappears when stale; verify private report isolation.
- Complete realistic historical/out-of-sample and Demo-forward validation before making performance claims. This upgrade supplies no fabricated win rate, expectancy or guaranteed profit.

The verification report records completed checks and the remaining external blockers. No order should be forced merely to pass acceptance or bypass an existing risk restriction.
