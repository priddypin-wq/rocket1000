# ROCKET1000

This upgrades the existing Next.js application and MQL5 Expert Advisor on `codex/professional-auto-trading-upgrade`. Original dark-purple/pink styling, Deadpool, account ownership and MT5 connection endpoints/configuration are preserved. The owner-approved release is deployed at https://rocket1000.vercel.app. Active terminal credentials were preserved and Live was not activated. The genuine OpenAI test currently reports AI_BILLING_REQUIRED; real broker acceptance remains outstanding.

## One-button workflow

1. Open **Settings → OPENAI AI CONNECTION**. Enter your own paid OpenAI API key in the initially blank masked field and Save. Test Connection verifies a real bounded Responses API request.
2. Keep your existing authenticated MT5 connection. The same EA handles Demo and Live and reports numeric `ACCOUNT_TRADE_MODE`, exact broker symbols, account values and execution results. Update to the verified EA 5.00 artifact for the new engine/risk boundary, retaining the connection configuration.
3. Press **START AI** on Home. It checks the key, scheduler, EA heartbeat, account, candles and risk configuration, then accepts a persistent analysis job. It does not grant trading permission.
4. **STOP AI** persists stopped state, invalidates in-flight results and prevents new analysis/order authorization. A separate **Emergency Stop** revokes order submission and Live approval. Neither closes positions automatically.

Home shows status, controls, account summary and activity. Market contains verified analysis, signals, owned positions and broker-confirmed results. MT5 contains the existing connection, copy URL, compiled download, account/balance/equity/broker verification. Settings contains the paid-key connection, essential authorization/risk controls and frequency/budget. `/analysis` redirects to Market. There are no charts, chat or voice controls.

## Security and authorization

Saved workspace keys use AES-256-GCM with random nonces and workspace/version-bound authenticated encryption. The separate 32-byte server encryption secret must be configured on the web backend and worker. Keys are sent only through HTTPS, private HttpOnly-workspace authentication and same-origin endpoints. Saved keys and fingerprints never return to the browser. Keys are absent from frontend code, browser storage, logs, EA packages and public URLs. Replace/Remove atomically revoke work; Remove prevents an environment key or Gateway silently reactivating the workspace.

The official OpenAI SDK uses the Responses API, bounded timeouts, no automatic provider retries, no response storage and no silent provider/model fallback. `OPENAI_MODEL` configures the reasoning model; the saved-key panel can explicitly replace the model when required. The supported default is not a promise of account access: an actual successful test is mandatory. See [OpenAI reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning) and [model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

Existing server `OPENAI_API_KEY` remains an explicit compatibility source until replaced or removed in that private workspace. Paid-key UI and worker always resolve direct OpenAI; they cannot bill an unrelated Gateway account. The billing link opens OpenAI's organization billing page; the user must sign into the organization owning their key. The app cannot infer or sign into that billing organization.

The AI proposes BUY/SELL/WAIT, size, SL/TP and explicit per-ticket management actions. The backend and EA independently validate account authorization, ownership, fresh data, broker permissions, margin, stops and risk. WAIT cannot open a position. Neither the EA nor a deterministic threshold independently generates a strategy trade. Broker protective stops and user-confirmed full closes remain separate controls.

Demo automatic execution requires a separate typed account confirmation. Live remains OFF by default and requires this engine's genuine automatic Demo OPEN → protective MODIFY → full CLOSE validation, then exact-account human approval and separate execution authorization. Switching accounts revokes approval. Unit/HTTP fixtures cannot qualify Live.

## Persistent execution and costs

Production uses **Vercel Queue callbacks sharing PostgreSQL**, with a genuine private callback check-in verified after deployment. A recurring run-bound chain invokes bounded engine cycles independently of the browser. Frequency, budgets and per-bar reuse limit model requests. Cursor claims, job leases and account/session/key generations reject duplicate or superseded work. Interrupted jobs fail closed. The supervised Node worker and protected scheduler endpoint remain optional alternatives. See [operator setup](OPERATIONS.md).

Default analysis frequency is five minutes, configurable from 60–3600 seconds. New closed-candle decisions are cached by run/bar; execution reuses the stored assessment rather than making a second paid request. Deterministic indicators are calculated locally. Text-only provider requests reserve conservative input/output cost before dispatch under a workspace lock. Verified token usage settles that reservation; missing usage or uncertain failures retain the full allowance. The default app budget is $2 per UTC day, configurable from $0.10–$10. Exhaustion, unknown prices and provider errors suspend new work.

Costs are **estimates**, using reviewed standard token rates without assuming cache discounts. This app-enforced budget covers this workspace's requests, not provider invoices, future rate changes or use of the same key elsewhere. Provider alert-only budgets cannot guarantee zero overspending. See [OpenAI pricing](https://developers.openai.com/api/docs/pricing).

## Strategies, data and risk

Price Action, Scalping and Adaptive selections retain closed M1/M5/M15/H1 candle analysis. RSI, MACD, EMA, ATR, volatility, spread, swings, support/resistance, breakouts/retests and trend/reversal observations are deterministic. SMC/ICT context includes geometric liquidity sweeps, displacement/order-block zones and fair-value gaps. These are descriptive observations, not validated probabilities or independent signals. Unknown economic news stays unknown; no news feed is fabricated. Uncalibrated model confidence is not shown as trade probability.

Hard ceilings are **0.5% per trade**, **5% daily loss**, **5% drawdown**, **three positions** and **3% aggregate open risk**. Stricter saved limits win, including after loading legacy 1% preferences. Sizing uses actual balance/equity, stop distance and broker tick/volume/margin checks; the old fixed 0.01-lot cap is removed. Broker minimum lots exceeding risk are skipped. No martingale or averaging down. Bounded winning additions require verified profitable protected same-side positions on a hedging account; they never bypass position/risk caps.

Only the authenticated active EA symbol is analysed, including broker suffixes. One active chart instance per private connection is supported. Owned off-chart positions remain visible until broker history confirms closure. Manual/unrelated trades are excluded from managed orders but count toward risk. Command acceptance, partial fills, execution and reconciliation remain distinct; the app never invents broker success.

## Development and verification

Use Node 22.16+ (tested with Node 24), `npm ci`, private local environment settings and `npm run db:migrate`. `npm run dev` runs the web app. `npm run worker:analysis` runs the separate worker. Hosted operation requires PostgreSQL and separately managed encryption secrets.

Checks: `npm test`, `npm run test:http`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and Windows `npm run build:ea`. MetaEditor generates the real EX5 with zero errors/warnings; authenticated packages require source/binary hashes matching `ea/build-manifest.json`. The build never installs into an active terminal.

Next.js is patched to 16.4.2 for the newly published [security advisory](https://github.com/advisories/GHSA-2464-fhr4-w9xw). See [verification, changed files and remaining acceptance requirements](UPGRADE-VERIFICATION.md). Git deployment is disabled for this review branch. The draft PR remains unmerged. Further releases and Live activation require their own applicable authorization.
