# ROCKET1000 approved production release

Record date: 27 October 2026, Africa/Johannesburg. The owner approved deployment with trading OFF and no broker orders.

- Public app: https://rocket1000.vercel.app
- Existing Vercel project: `prj_oTLaK79PdNcNy8dpXiINtTiqlAsC`, workspace `sniper-fx`.
- Deployed application source: `4386d6591ed2860b983b6949c9777b8888828e23`.
- Deployment: `dpl_FdQA68t7hJ5uhzGwwSqCyaAJ258n`.
- Tested deployment URL: https://rocket1000-c2iqyrbuf-sniper-fx.vercel.app
- State: Ready, promoted to the existing public domain. PR #4 remains draft and unmerged.

## Release safety and data preservation

The application was copied from the clean approved Git commit into an isolated release folder. No local environment files, databases, personalized EA source, browser cookies or test fixtures were uploaded. A one-off administrative build step used the existing exported pause/stop functions; application source was unchanged.

Before migration, an encrypted logical snapshot of 32 existing database tables was saved inside the protected existing database. This supplements provider backups and is not an off-site disaster-recovery copy.

The release explicitly paused all 17 preexisting connections with connection locks and new stop/run generations. Before and after the build, the release verified zero unpaused connections, zero active/verifying engines, zero running automation, zero trading policies, zero queued commands and zero in-flight/uncertain commands. Existing installation credential hashes, expiry and revocation records were unchanged. No positions were closed or modified by this operation.

The release was staged without moving the main public domain, tested, then promoted without rebuilding. Direct unauthenticated HTTPS checks confirmed the new Home controls, Market chart panel, MT5 and Settings pages, health API and web manifest all return HTTP 200 at the public app. The unique staged URL was tested through the authorized Vercel CLI without disabling Deployment Protection.

## Actual release checks

The staged release passed 10 checks; the public production release passed 11 checks. These covered:

- Correct live service/database health and all four upgraded screens.
- Private account/report endpoints rejecting anonymous access.
- Secure HttpOnly/SameSite workspace cookies.
- Generated EA configuration retaining `https://rocket1000.vercel.app`.
- Real compiled EA 6.00 ZIP download matching its verified SHA-256 manifest, with private scoped expiring configuration and installation instructions.
- Personalized MetaEditor source using the same credential across repeat downloads, with no external configuration dependency.
- Server-managed OpenAI metadata without credential disclosure.
- Persisted Stop state, no trading authorization and no fabricated connection, chart or positions in the empty verification workspace.
- A bounded genuine OpenAI diagnostic that left automated trading OFF.

Verification used isolated private workspaces without submitting broker telemetry or trading commands. Both issued test installation credentials were revoked after their checks. Existing owner credentials were preserved. No broker orders were submitted by the release.

## OpenAI result and remaining acceptance

The deployed server has an environment OpenAI credential configured for `gpt-6.1-sol`. The actual Responses connection test was handled by the backend but **did not connect successfully**: `AI_BILLING_REQUIRED` — credits or a billing limit need attention in the active API account. No successful inference, signal or trade is inferred from this error.

Review billing in the OpenAI organization/project that owns the server key, then use Settings → Test Connection. API keys and payment details stay in the provider/hosting settings. This release did not change or expose the OpenAI key.

The matching EA 6 must be installed on the connected Windows/MT5 host before genuine Demo acceptance. The deployment does not install or attach an EA on the laptop/VPS. Keep Auto Trading OFF until the funded API and fresh authorized Demo terminal can be tested together. Genuine AI-to-EA-to-broker entry, management, exit and reconciliation remain unverified; no Live execution or profitability claim is made.

Post-release Android/browser visual inspection was unavailable; verification used actual HTTP/API responses and the previously completed build/type/lint/unit checks. No native Android APK is claimed. See [installation instructions](INSTALLATION.md) and [full implementation verification](UNIFIED-UPGRADE-VERIFICATION.md).

The earlier deployment `dpl_3tcegNyyEJaRogZigBWsWRYkVYt1` remains the prior rollback target. Trading OFF is persisted in the database and is not reset merely by a domain promotion. Future activation remains an explicit owner action subject to all current account, provider, broker and risk checks.
