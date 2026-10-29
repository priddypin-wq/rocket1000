# ROCKET1000 activation-ready application release

Released 28 October 2026, Africa/Johannesburg, under the owner's instruction to finish and deploy without waiting for funded OpenAI access or an attached terminal. **Software is deployed; genuine paid AI and broker execution remain external acceptance requirements.** No broker orders or Live activation were performed.

- Public application: https://rocket1000.vercel.app
- Existing Vercel project: `prj_oTLaK79PdNcNy8dpXiINtTiqlAsC`, team `team_x23mVxLOTgdV70YhR8mnnRhm` / `sniper-fx`.
- Deployed source: `75af6cef35949b5650b20344fe052c75c9d729f7`.
- Deployment: `dpl_9QXa43sfrhbXpAj5jZgw9rBqPifi`.
- Tested staged URL: https://rocket1000-ooxbw5avz-sniper-fx.vercel.app
- Engine: `rocket-ai-7`; compiled **ROCKET1000 EA 7.00**.
- Prior deployment / rollback target: `dpl_FdQA68t7hJ5uhzGwwSqCyaAJ258n`, engine 6.
- PR #4 remains draft and unmerged; automatic Git deployment stays disabled for the review branch. A later documentation commit is not a new application deployment.

## Safe release workflow

The existing Vercel CLI account verified the exact project/team. The connector still returned a scope 403, so the already-authorized established CLI workflow was used. No account, project, database, public hostname, secret or connection credential was replaced.

A clean archive of the reviewed commit was uploaded without local environment files, databases, browser profiles or private EA configurations. The release-only build command ran the existing encrypted pre-migration backup and idempotent migration, the reviewed `scripts/release-safety.mjs --apply`, the Next build and `--check`. Application source was unchanged; only that administrative build command differed from the standard configuration.

The encrypted logical pre-migration snapshot covered **34 tables**, reference `8f42e0d8-7227-4981-88ec-a5e698d3f026`, inside the existing protected database. It supplements provider backups and is not an off-site recovery copy.

Before and after the build, actual aggregate queries confirmed all **19 preexisting connections** stopped, both execution and analysis activation paused, zero active/verifying engines, zero active automation, zero policies, zero queued/in-flight/uncertain commands. Installation credential hashes, expiry and revocation records were unchanged. Existing positions were not closed or modified. The operator Live-order switch and all server secrets were left unchanged.

Production was staged with `--prod --skip-domain`. The public alias was confirmed to remain on the prior release during staged verification. After all staged checks passed, that exact build was promoted without rebuilding, and the public alias was checked against the new deployment ID.

## Actual verification results

- **451 unit/service tests**, zero failures/skips, including account authorization/recovery, strict output validation, hard risk rules, broker ownership/reconciliation, idempotency and the new fair worker discovery/release safety cases.
- **56 local HTTP integration checks** against actual Next routes with isolated fixture telemetry and provider credentials explicitly blanked.
- Next production build, TypeScript and zero-warning ESLint passed. The cloud production build also succeeded.
- Official MetaEditor freshly compiled EA 7.00 with **0 errors and 0 warnings**. Source SHA-256: `0b7d2aa4e9fcb2e0c2e280cb128cf7fe03e0dc25c1a184dbfe16cb51dff84e26`; binary SHA-256: `13cefea04020c3e22a57820ee07532e8c2b8e86151c9dd419edb76f0d6356813`.
- **11/11 staged hosted checks** and **11/11 public hosted checks** passed. They covered actual health/migrated database, three-tab UI and removed cards, private endpoint authentication, secure browser cookies, the unchanged canonical HTTPS origin, the genuine compiled EA package/hash and private configuration, repeat-download credential reuse, server-only OpenAI metadata, persisted Stop, an actual private Queue callback and honest empty broker reports.
- **12 local and 14 public responsive browser checks** passed at Android-sized 390×844 and desktop 1280×900. The public run also verified loaded server model metadata and Emergency Stop through the real authenticated backend in an empty test workspace. There were no uncaught browser runtime errors. This is emulation, not physical Android hardware or a native APK test.
- Known-private-value scans found no matches in the staged source or public build artifacts. The public-artifact scan covered the one available local private value across 17 artifacts; it does not claim access to every production secret.

Each hosted provisioning check used its own empty private workspace and revoked its issued EA credential afterward. Browser verification used a separate empty browser profile and left its workspace emergency-stopped. Tests submitted no production market telemetry, broker commands or paid OpenAI requests. Queues were verified by genuine authenticated callbacks, not by pretending a permanent serverless worker was running.

## Activation remains external

The deployed server reports an environment OpenAI key configured for `gpt-6.1-sol`; no credential is returned. The last genuine provider test from the prior release returned **`AI_BILLING_REQUIRED`**. This release did not run or claim a successful paid inference. Fund that key's actual OpenAI project privately, then use header gear → OpenAI AI Connection → Test Connection. Replacing a key/model uses the normal hosting environment workflow; no trading-engine rewrite is needed merely to fund the existing configured key.

Download the matching **EA 7** from MT5, preserve its bundled scoped configuration, add the public HTTPS origin to MT5 WebRequest and attach it on the connected Windows/VPS terminal. Account type is detected automatically. Analysis can initialize from fresh authenticated data and actual scheduler readiness; a persisted Stop still requires explicit resume. Demo and Live use the same engine, with execution only after account authorization and all current checks. No Live authorization was granted by deployment.

A separately authorized genuine **Demo** qualification must still verify entry, protective SL/TP, modification/close, broker fills/rejections/partials where available, reconnect/restart recovery, history reconciliation and risk protection. A separate exact-account Live-readiness review follows that evidence. Controlled fixture tests cannot substitute for those checks. No backtest profitability, win rate, guaranteed return, real AI-to-broker cycle or physical Android acceptance is claimed.

See [activation readiness](ACTIVATION-READINESS.md), [installation](INSTALLATION.md), [operator setup](OPERATIONS.md) and [adaptive implementation details](ADAPTIVE-UPGRADE-VERIFICATION.md). Local logs/screenshots remain in ignored `work/activation-*` paths; private cookies/configurations are not published.
