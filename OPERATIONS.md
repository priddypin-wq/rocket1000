# ROCKET1000 operator setup

These are deployment requirements, not completed production steps. Do not put keys, database credentials or encryption secrets in GitHub or chat. The user-facing MT5 URL, token workflow and protocol remain unchanged.

## Existing target and release boundary

The owner-selected application is https://rocket1000.vercel.app, existing project `prj_oTLaK79PdNcNy8dpXiINtTiqlAsC` in workspace `sniper-fx`. The latest Vercel connector read returned 403 because it lacks access to that scope. The owning account must authorize that existing team/project before inspection or a separately approved release. Do not create a duplicate project.

The review branch explicitly disables Vercel Git deployment. No production deployment, database migration, key change in production or Live activation has been performed by this upgrade.

## Web backend configuration

Keep the existing HTTPS `ROCKET_DASHBOARD_URL`, `ROCKET_BACKEND_URL`, PostgreSQL `DATABASE_URL` and EA configuration. Add **ROCKET_OPENAI_ENCRYPTION_KEY** as a separately managed server secret: canonical base64 encoding of 32 cryptographically random bytes. Generate it privately with a secret manager; never store it alongside the encrypted database payload. Do not reuse the OpenAI key as the encryption key. Keep a protected backup: changing/loss of this secret makes existing ciphertext unreadable until keys are re-entered.

Use the identical encryption secret in the web backend and analysis worker. Configure `OPENAI_MODEL` with a reasoning model that supports Responses and structured output. Default `gpt-6.1-sol` is supported, but availability to the paid API account must pass the actual connection test. Known standard-price catalog entries are `gpt-6.1-sol`, `gpt-5-mini` and `gpt-5.4`. Other models require verified operator `ROCKET_AI_INPUT_USD_PER_MILLION` and `ROCKET_AI_OUTPUT_USD_PER_MILLION` rates; no guessed fallback price is used. The model and price configuration must match between web and worker.

Run the existing idempotent `npm run db:migrate` against the intended release database before serving the upgrade. New tables store encrypted credentials, persistent analysis jobs, actual scheduler check-ins and usage reservations. Back up the database before an approved production migration. Never pull production secrets into a public build artifact.

## Dedicated worker (recommended)

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
