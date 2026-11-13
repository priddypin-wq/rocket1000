# Existing ROCKET1000 button audit

The existing page structure, controls, navigation, colors, CSS, assets and EA
artifact are preserved. Changes repair handlers, account/session fences,
duplicate-tap protection and loading/error/confirmation messages. All private
actions use the existing HttpOnly browser session and the single MT5 connection.

## Reachable controls

| Screen/control                                                               | Intended action and verification                                                                                                     | Genuine missing requirements                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Home, Market, MT5 navigation; wordmark; Home/back and connection/order links | Existing routes and redirects; browser navigation checked                                                                            | None                                                                                                                                     |
| Gear; Connection details; drawer Close/Escape                                | Open/close the existing diagnostics drawer; browser checked                                                                          | None                                                                                                                                     |
| Diagnostics disclosures, history and analysis disclosures                    | Native disclosure behavior retained                                                                                                  | Their content needs verified data                                                                                                        |
| Resume Analysis / Pause AI                                                   | Persistent engine start/stop; duplicate starts share one request; Stop preempts verification and invalidates delayed Start           | Fresh matching EA account/session, current engine status, actual worker and verified OpenAI for Start                                    |
| Enable / Stop Auto Trading                                                   | The same engine for Demo and Live; captured account, installation, terminal session and control revision checked again by backend    | Fresh broker permissions, OpenAI readiness, risk eligibility; exact Live approval and operator switch also apply                         |
| Emergency Stop, including drawer copies                                      | Confirm backend `{ok:true,tradingEnabled:false}`; shared control state invalidates stale ON responses; no position-close instruction | Network/backend access required to confirm; failure is never called stopped                                                              |
| Close Position                                                               | Review the exact owned position/account/session; one confirm per review; read the exact private command result                       | Current execution authorization, fresh owned position and symbol checks, broker permissions/session, no unresolved prior submission      |
| Close Cancel / Confirm / Check original close request                        | Keep the same review after an ambiguous network failure; replay only its idempotent confirmation, never create a replacement order   | Review identity must still match; expiry applies unless retrieving the original confirmed request                                        |
| Copy report                                                                  | Fresh authenticated report, exact account comparison, awaited clipboard result                                                       | Verified account and clipboard permission                                                                                                |
| Download CSV                                                                 | Private current report download; account fence and nonempty CSV response checked; reports a download request, not proof of saving    | Verified account, backend and browser download support                                                                                   |
| Generate Connection                                                          | Real HTTPS verification response must name the existing connection; no success for arbitrary HTTP 200                                | Reachable configured canonical backend                                                                                                   |
| Copy EA Connection URL                                                       | Await clipboard completion; no token in URL                                                                                          | Generated verified URL and clipboard permission                                                                                          |
| Download compiled EA / MetaEditor source                                     | Validate connection ID, file type/nonempty response; retain the active installation credential                                       | Verified backend and compiled artifact; network access                                                                                   |
| Replace EA installation / Cancel / Replace & download                        | Existing explicit replacement review retained; double taps cannot rotate twice                                                       | Existing active credential and explicit replacement confirmation                                                                         |
| Revoke EA access                                                             | Await actual `{ok:true}` before success; failed status refresh does not mislabel confirmed revocation                                | Active installation credential and backend access                                                                                        |
| OpenAI Test Connection                                                       | One bounded server request; exact boolean verification and real error states                                                         | Configured server credential, HTTPS, supported model, paid billing and server budget                                                     |
| OpenAI billing link                                                          | Existing OpenAI organization billing URL retained                                                                                    | User must use the organization owning the configured backend credential                                                                  |
| Save / Replace / Remove API Key; removal Cancel/Confirm                      | Existing conditional key-management UI retained, key immediately cleared/masked, server storage/removal confirmation required        | These controls exist only when the operator enables customer-managed credentials; production currently uses server-managed configuration |
| Live account Review / Cancel / Confirm account approval                      | Exact account, installation, session, settings revision and expiry are bound; approval alone never starts trading                    | Connected Live account, current broker checks and explicit checkbox approval                                                             |

## Existing components that are not routed into the current app

`TradeControls`, `PositionControls` and `SettingsNotifications` have no current
page imports. Their existing lower-risk/save-limit/stop, review-modification/
review-close and notification handlers were checked and duplicate taps guarded.
They were not added to any screen. There are no reachable manual BUY/SELL
buttons in the present design; none were invented for this repair. The existing
AI-approved BUY/SELL API/EA pipeline remains subject to its independent tests and
all authorization/risk rules.

## Broker result reporting

Queued, received by EA, sending, uncertain, failed, expired, cancelled, partial
fill and confirmed execution are separate states. Close status polling is scoped
to one private command and current account. A partial/executed label needs actual
broker deal, volume, price and valid acknowledgement evidence before the UI says
confirmed. Position cards are never removed optimistically. Unknown outcomes
instruct the user not to submit a replacement; actual MT5 reconciliation decides.

## Verification and external acceptance

Controlled tests exercise actual TSX handlers, persisted services and HTTP routes
with isolated response/terminal fixtures. Browser checks cover existing routes,
drawer open/close, Emergency Stop in an empty local workspace, disabled reasons
and genuine HTTPS-generation failure. Fixtures never represent live trading.

Final checks: **515 automated tests**, **64 HTTP integration checks**, TypeScript,
zero-warning ESLint and the Next.js production build pass. An element/style-class
comparison confirms all ten edited components retain their existing structure;
CSS, navigation, assets and EA source/binary have no changes. The real compiled
EA integrity test passes. No new EA compilation is needed for these browser/API
handler repairs.

Post-deployment browser checks verified real Generate Connection completion and
received the compiled EA ZIP. Its binary hash, canonical backend URL, scoped
credential, expiry and installation instructions were checked without exposing
the credential. Fresh EA heartbeats continued after download. The copy handler
reported browser write completion; independent clipboard inspection through the
in-app automation bridge was inconclusive and is not claimed as an external pass.
Initial MT5 loading is explicitly shown as checking, rather than disconnected.

Live read-only inspection on 29 October 2026 showed the authenticated Demo
terminal connected. Private account identifiers are omitted here. The existing
diagnostics reported:

- OpenAI: `AI credits or a billing limit need attention in the active provider account.`
- `Verified execution costs and complete broker loss history are required for new orders.`
- `Spread exceeds 100 points.`
- Current account execution permission: OFF.

These are real remaining readiness requirements, not dead button handlers. They
must not be bypassed or presented as passed. A spread can normalize with market
conditions; broker cost/history verification needs genuine broker information.
Live account approval remains separate and the operator-controlled Live safety
switch is preserved. No broker order or paid model request was initiated for
button testing. Genuine demo/live entry, modification, close and fill acceptance
remain external checks, so OpenAI configuration is not the only unverified item.
