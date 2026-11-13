# ROCKET1000 repair and verification

Prepared for review on the existing `codex/professional-auto-trading-upgrade` branch. The repaired build uses the original application and Navigation EA, with one authenticated backend connection and one terminal. The public deployment and the local MT5 installation have not been updated. No broker orders were submitted.

| Check | Result | Evidence or remaining requirement |
| --- | --- | --- |
| App HTTPS and private workspace | PASS | The current production Market page and health route responded. The private diagnostics drawer loaded its existing workspace. The repaired application routes were tested against an isolated database. |
| OpenAI | BLOCKED | One actual server-side connection test on the existing deployment used the configured `gpt-6.1-sol` model. The app reported a provider request limit and stayed Disconnected. Earlier status reported a billing or credit problem. The latest public diagnostic cannot distinguish that earlier problem from ordinary throttling. A successful model response is unverified. |
| MCP | BLOCKED | No application MCP server, client configuration, or tools were found in the tracked repository. Codex connectors are separate from ROCKET1000. An actual application MCP endpoint and its intended use are needed to verify this integration. The existing OpenAI Responses and EA HTTPS paths were retained. |
| Navigation EA | PASS for compilation | The existing MQL5 source compiled in MetaEditor with zero errors and warnings. Source and binary match the checked build manifest. The compiled repair was not attached to a live terminal. |
| App-to-EA connection | PASS in isolated tests, BLOCKED for live check | Credential ownership, registration, quote withdrawal, reconnect, and competing chart rejection passed. The existing production workspace last received an MT5 heartbeat on November 10, 2026. |
| MT5 Demo account | BLOCKED | The app retains the existing RCG Markets Demo identity. The local terminal is closed. The locally installed binary matched the historical 5.00 artifact rather than the current 7.00 source and build. The runtime version and account login must be checked in MT5. |
| Broker permissions | BLOCKED | Production showed execution OFF, Emergency Stop active, and no fresh heartbeat. Current terminal, EA, account, and broker permission flags need a connected terminal. The repaired EA reports those flags individually. |
| GOLD | BLOCKED | `XAUUSD` was found in the target demo server's historical data cache. Its current availability, exact broker specification, prices, and costs were not verified. |
| GER30 | BLOCKED | No current broker-confirmed symbol name, prices, or specifications. |
| NAS100 | BLOCKED | No current broker-confirmed symbol name, prices, or specifications. |
| AI trading pipeline | PASS in isolated tests, BLOCKED for live verification | The suite exercises real application code with controlled model and EA responses, including protected order requests, risk rejection, reconnect, duplicate suppression, and broker result reconciliation. Paid inference on fresh broker data and actual native broker `OrderCheck` are unverified. |
| Demo broker execution | NOT TESTED | Requires a fresh qualified Demo connection, passing broker and risk checks, and explicit approval of the specific minimum-volume order. |

## Repairs

- `ea/ROCKET1000_EA.mq5`, the matching `.ex5`, and `ea/build-manifest.json` retain the same installer and protocol. The EA sends a broker-disconnect event on its existing session when it can reach HTTPS, and explicitly marks missing quotes. It still has a single native `OrderSend` path guarded by independent permissions, risk checks, margin calculation, and `OrderCheck`.
- `server/provisioning.mjs`, `server/trading.mjs`, and `server/broker-specification.mjs` invalidate old quotes when the terminal disconnects or loses data, retain the last heartbeat timestamp, validate broker permission flags, and associate the specification with the exact authenticated chart symbol. Authenticated diagnostics report the observed bid/ask and spread, minimum lot, margin estimates, trading sessions, swap, stops, execution mode, available M5 bars, and observed commission when verified. Margin estimates do not substitute for order preflight. Specifications cover the existing chart symbol. Use one chart at a time to verify another symbol.
- `app/api/mt5/{generate,download,revoke}/route.ts`, `server/ea-installation-actions.mjs`, `server/database.mjs`, `lib/action-confirmation.mjs`, `lib/browser-download.mjs`, and `app/components/mt5-connection.tsx` bind actions to the current installation. Downloads check connection, protocol, content type and digest. Replacement retries reuse one recorded request and cannot rotate twice. Revocation checks the reviewed installation. The new `rocket_ea_installation_actions` table is additive and stores request identity, not credentials.
- `server/ai-provider.mjs`, `server/ai-connection.mjs`, `server/openai-credentials.mjs`, `server/engine-activation.mjs`, and `.env.example` distinguish prepaid credits, project and organization limits, request throttling, model access, and invalid configuration. Optional OpenAI organization/project headers are server-only and are not inherited by saved workspace keys. No provider key or production setting was changed.
- `server/engine-service.mjs` preserves the selected strategy, trading mode, and settings revision on Start. The existing Adaptive Hybrid strategies and 0.25% trade and aggregate caps, 1% daily equity-loss cutoff, and one-position pilot cap still apply. The one-position cap blocks additions during this pilot. Demo and Live share the same pipeline with separate Live authorization.
- `app/components/engine-diagnostics.tsx` and `lib/trading-types.ts` present the new data inside the existing diagnostics drawer. CSS, navigation and page layout were preserved. Test and verification changes are in `tests/` and `scripts/test-http.mjs` and `scripts/verify-live.mjs`.

## Control verification

PASS below means the action passed in the isolated app, handler, or protocol suite. A genuine broker or provider outcome requires the separate checks above.

| Control | Result | Verification |
| --- | --- | --- |
| Navigation, drawers, disclosures, history and analysis reads | PASS | Existing routes render and private reads require their workspace. Fresh and stale quote behavior passed. |
| Resume Analysis, Pause AI, Enable and Stop Auto Trading | PASS | Persistent control revision, scheduler checks, Demo/Live account checks and stop-before-start tests. Live provider activation remains blocked. |
| Emergency Stop | PASS | Confirmed backend stop, revoked execution and no automatic close in the isolated HTTP suite. |
| Close Position, Cancel, Confirm and Check Request | PASS in isolated tests | Owned-position review and result checks, duplicate rejection and uncertain-order reconciliation. Genuine close/fill unverified. |
| Copy Report and Download CSV | PASS in isolated tests | Private report endpoints and retained handlers. The previously removed Market card stays hidden. |
| Generate Connection and Copy EA URL | PASS in isolated tests | Verified connection and installation identity, no credential in URL, awaited clipboard result. Actual OS clipboard round-trip unverified for this build. |
| Compiled EA and MetaEditor source download | PASS | Local HTTP responses and handler checks. The ZIP contains the compiled artifact and scoped config. The separate source download uses the matching source template. |
| Replace, Cancel, Replace & Download and Revoke | PASS in isolated tests | Explicit review, duplicate request replay, outdated installation rejection, confirmed revocation and failure messaging. |
| OpenAI Test Connection | BLOCKED | The control made the real provider test and displayed its failure. See OpenAI above. |
| OpenAI key controls and billing link | PASS in isolated tests | Server-managed defaults and masked customer-managed handling. Real key changes and billing changes were outside the test. |
| Live approval Review, Cancel and Confirm | PASS in isolated tests | Account/session-bound review and rejection checks. No live permission granted. |
| Windows and Android workspace continuity | UNVERIFIED | Existing browser workspaces remain isolated. This repair adds no cross-device identity provider or pairing flow. |

## Verification commands

- `npm test` passed 524 tests.
- `npm run test:http` passed 64 isolated HTTP checks.
- `npm run lint` and TypeScript checking passed.
- `npm run build` compiled the production app locally.
- `pwsh -NoProfile -File scripts/build-ea.ps1` compiled the EA with zero errors and warnings. Both artifacts match the manifest.

## Release and live checks

1. Review the local changes and use an isolated preview and database to verify the build and additive migration. A production promotion is a separate action.
2. When MT5 is available, open the existing RCG Markets Demo account with Algo Trading off. After the repaired app is released, download the same EA normally. Keep the existing private config and terminal data folder. Install the matching `.ex5` in place and attach the EA to one chart. Confirm `https://rocket1000.vercel.app` is allowed under MT5's WebRequest settings. Use the existing **Replace EA installation** control only if intentionally rotating a credential.
3. Confirm a fresh heartbeat and check **AI Engine Configuration → Broker & risk engine diagnostics**. Use MT5's Market Watch to identify each broker instrument. Inspect each exact symbol with the same EA and connection, one chart at a time. Read and verify its quote, contract and trading conditions before any preflight.
4. In the OpenAI organization that owns the deployed API key, check the project's model access, rate limits, usage, and billing. Add credits only if the organization is out of credit. Once the issue is resolved, run one **Test Connection** and require Connected before testing analysis.
5. Review current permissions and risk before authorizing any Demo execution. Native order preflight remains in the EA's checked order path. Live execution is outside this verification.
