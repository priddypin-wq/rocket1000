# ROCKET1000 operator setup

Do not put keys, database credentials or encryption secrets in GitHub or chat. The user-facing MT5 URL, token workflow and protocol remain unchanged. The release below was deployed and verified on 24 October 2026; genuine broker execution remains an acceptance requirement.

## Existing target and release boundary

The owner-selected application is https://rocket1000.vercel.app, existing project `prj_oTLaK79PdNcNy8dpXiINtTiqlAsC` in workspace `sniper-fx`. Owner-approved Vercel CLI access verified and linked this exact project. Deployment `dpl_3tcegNyyEJaRogZigBWsWRYkVYt1` was staged, checked and promoted. Do not create a duplicate project or change its existing Git repository mapping merely to deploy.

The review branch explicitly disables automatic Vercel Git deployment; this release used the approved manual CLI flow. Production migration preserved old records and saved an authenticated encrypted logical rollback snapshot of 24 existing tables inside the same database before applying additive schema changes. That snapshot supplements provider backups; it is not an off-site disaster recovery copy. A separate encryption secret and Queue flag were added without replacing the OpenAI key, database, HTTPS URLs or active EA credentials. Live was not activated.

## Web backend configuration

Keep the existing HTTPS `ROCKET_DASHBOARD_URL`, `ROCKET_BACKEND_URL`, PostgreSQL `DATABASE_URL` and EA configuration. Add **ROCKET_OPENAI_ENCRYPTION_KEY** as a separately managed server secret: canonical base64 encoding of 32 cryptographically random bytes. Generate it privately with a secret manager; never store it alongside the encrypted database payload. Do not reuse the OpenAI key as the encryption key. Keep a protected backup: changing/loss of this secret makes existing ciphertext unreadable until keys are re-entered.

Use the identical encryption secret in the web backend and analysis worker. Configure `OPENAI_MODEL` with a reasoning model that supports Responses and structured output. Default `gpt-6.1-sol` is supported, but availability to the paid API account must pass the actual connection test. Known standard-price catalog entries are `gpt-6.1-sol`, `gpt-5-mini` and `gpt-5.4`. Other models require verified operator `ROCKET_AI_INPUT_USD_PER_MILLION` and `ROCKET_AI_OUTPUT_USD_PER_MILLION` rates; no guessed fallback price is used. The model and price configuration must match between web and worker.

Run the existing idempotent `npm run db:migrate` against the intended release database before serving the upgrade. New tables store encrypted credentials, persistent analysis jobs, actual scheduler check-ins and usage reservations. Back up the database before an approved production migration. Never pull production secrets into a public build artifact.

## Production Vercel Queue scheduler

Production sets `ROCKET_QUEUE_ANALYSIS=1`. The private `queue/v2beta` trigger in `vercel.json` subscribes `/api/queues/analysis` to `rocket1000-analysis`. The SDK authenticates through Vercel OIDC. An authenticated dashboard status request may publish a debounced infrastructure probe; only its real private callback records health. Production callback delivery was verified without requesting a signal or issuing an order.

After explicit START and existing credential/MT5 checks, the adapter publishes a run-bound job. Each bounded callback invokes the existing budgeted engine and schedules a 60-second continuation while that exact run remains active. Configured analysis frequency and per-bar reuse independently control model calls. Persistent cursor claims, leases and publish idempotency prevent duplicate chains; engine run checks inside its transaction prevent old deliveries from claiming a restarted session. Queue liveness is scoped to the exact connection and active run for trading authorization. STOP, stale data, key changes, exhausted budgets and scheduling failures prevent further submissions. The app does not rely on an open browser or a permanent serverless request.

Inspect actual callback and usage logs after releases. The initial genuine Responses test returned `AI_BILLING_REQUIRED`; the configured key needs funding or a billing-limit change in its own OpenAI account. No successful paid inference or broker execution is claimed. A short scheduler probe is not an end-to-end trading qualification.

## Optional dedicated worker

Run `npm run worker:analysis` as a supervised long-lived service on an appropriate worker host using the same release, `DATABASE_URL`, encryption secret and model/pricing environment as the web backend. Set `NODE_ENV=production`; the worker refuses production SQLite. It needs outbound HTTPS to api.openai.com and the database. It does not require broker passwords or a public inbound port.

`Dockerfile.analysis-worker` provides an optional container definition. Its allowlisted build context excludes environment files, local databases, work artifacts and Git history. The image definition has not been built here because Docker is unavailable. The Node worker itself was run locally in isolation and its check-ins continued after the review browser closed; there were no broker jobs or orders.

Use normal supervision/restart policies and an adequate shutdown grace period for a bounded in-flight request. Each process has its own heartbeat ID. Liveness expires after 150 seconds. Scheduled jobs can resume after a healthy process restart; interrupted in-flight leases are stopped and require explicit restart, never blindly resubmitted. STOP AI invalidates the persisted run generation; it also best-effort aborts an in-flight provider request after the stop is observed. Already dispatched requests can still incur provider charges.

## Optional scheduler integration

`GET /api/internal/ai-engine` accepts only HTTPS and an Authorization Bearer value equal to an operator-managed `CRON_SECRET` of at least 32 random characters. Each call records a genuine check-in and drains one bounded job with a persistent lease. It never accepts a browser cookie as scheduler authorization.

This endpoint is **not scheduled simply because it exists**. A suitable platform or external scheduler must actually call it at the chosen cadence. Vercel cron limits depend on the account plan; no paid plan or schedule was created by this task. If using it instead of a dedicated worker, configure and verify actual executions, capacity and secret handling before telling users the service is available. A short-lived web request is not a permanent worker.

## User acceptance sequence

1. Verify the approved deployment and actual scheduler check-in. With no scheduler, START AI must fail honestly.
2. In Settings → OPENAI AI CONNECTION, save the paid key through HTTPS. Confirm the field clears and a reload never returns the saved key. Test Connection must succeed with a real Responses request; handle access, credit and rate errors without starting trades.
3. Keep the existing MT5 connection and install the verified EA 5.00 with the existing bundled configuration. No manual server/token entry is introduced. Verify Demo/Live detection, exact account/broker/symbol, real financial data and a recent heartbeat.
4. START AI runs analysis with no trading permission. Close the browser and verify fresh persisted analysis from the worker, then reopen the app. Test STOP, worker failure, stale broker data and key replacement/removal.
5. On a genuine Demo account only, separately type the account confirmation in Settings to authorize execution. Observe real AI → command → EA → broker OPEN, protective MODIFY and full CLOSE. Confirm actual tickets/fills/history and no duplicate execution. Unprotected external positions, excess account exposure, missing verified safety information or stale data legitimately block this test; do not bypass them.
6. Live stays OFF until this engine's genuine Demo gate passes and the owner separately approves the exact Live account. This upgrade does not grant that approval. Do not place Live development trades.

Emergency Stop revokes new submission/Live authorization independently of analysis and leaves positions open. User-reviewed full closes require their own bounded permission and confirmation. Where this engine is still blocked, review or close positions directly in MT5. Broker SL/TP remain independent protections; an already-sent order cannot be recalled. Gaps, slippage and fees can exceed estimated stop risk.
