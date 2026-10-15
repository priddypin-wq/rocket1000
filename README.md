# rocket1000 — GPT-6.1 Sol + MT5 (DEMO ONLY)

This repository now contains a **development scaffold** for analysing closed EURUSD M15 candles with GPT-6.1 Sol and optionally executing a **demo** trade in MetaTrader 5. It has **not** been deployed, compiled in MetaEditor, connected to a broker, or tested with real market data. Do not enable live trading.

## Design

1. The MT5 Expert Advisor (EA) runs on your computer or VPS, attached to a **demo** EURUSD M15 chart. It takes 40 **closed** candles and an account snapshot once per new M15 bar.
2. It sends the snapshot over localhost HTTP, or HTTPS for any remote endpoint, with a private bearer token to `POST /api/mt5/signal`.
3. The Node.js server verifies an allowlisted demo account, market freshness, closed candles, symbol, spread, exposure, a daily equity baseline and a **persisted one-signal-per-bar reservation** before calling the OpenAI Responses API using `gpt-6.1-sol`.
4. The model outputs one strict-schema recommendation: BUY, SELL, or WAIT. A deterministic trend, volatility and minimum-confidence gate can convert a BUY/SELL into WAIT.
5. The EA **independently** checks actual MT5 `ACCOUNT_TRADE_MODE_DEMO`, account login, account positions, pending orders, spread, daily drawdown, permissions, stop distances, risk-based volume and free margin immediately before submitting an MT5 order.

**No GPT response can directly determine the lot size, stop-loss, or account.** The EA computes these itself with `OrderCalcProfit` and broker contract settings. This system does not claim profitable trades, guaranteed 0.25% loss, or news awareness: slippage, gap risk, commissions, missing data, feed outages, swap and broker execution behavior can increase realised loss.

### Locked risk rules

| Restriction | Enforced |
|---|---|
| Live account | Hard-blocked in EA `OnInit` and every order check |
| Allowed MT5 account | Explicit demo login matches EA and API config |
| Default execution mode | OFF, requires deliberately enabling **both** server and EA |
| Symbols/timeframes | One explicitly configured symbol; M15 only |
| Risk per new trade | At most 0.25% *theoretical stop-loss risk* based on broker's OrderCalcProfit estimate |
| Equity loss halt | No new trades after 1% daily equity drawdown from the day's first recorded equity |
| Open positions / pending orders | Zero required across the entire account |
| Maximum spread | 20 points (or lower EA setting) |
| Maximum simultaneous new orders | One EA per account; run only one instance; server reserves each bar |
| Stop loss | Max of 2 × ATR(14) or broker stop-distance-plus-spread buffer |
| Take profit | 2 × stop-loss distance |
| AI trade confidence | 0.75 minimum plus EMA(9)/EMA(21) alignment |
| Duplicate/new bar protection | Persisted server reservation plus MT5 terminal global variable |
| Emergency stop | Set MT5 global variable `r1000.<demo-login>.STOP` to `1` (F3); or remove EA/turn off Algo Trading |
| Fail-safe behavior | On no key, invalid credentials, missing candles, model failure, timeout or spread breach: WAIT / no new trade |

Important: MT5's stop-loss is an order, **not a guaranteed execution price**. The two daily drawdown baselines use UTC on the server and broker-day on the EA, respectively; both can block orders. Daily baselines are recorded at the first valid call of that day, not at broker midnight. Maintain a dedicated demo account and avoid making manual trades while evaluating.

## Prerequisites

- Node.js 22.16 or newer and MetaTrader 5 desktop **MetaEditor** on Windows or a compatible VPS.
- An existing OpenAI API project with billing enabled. This is **separate** from ChatGPT Plus. API model: `gpt-6.1-sol`.
- A **DEMO** account at your broker. Keep demo and live account credentials separate. No payment or live trade permission is needed for this source-code scaffold.

## 1. Start server locally (AI disabled by default)

```bash
git clone https://github.com/priddypin-wq/rocket1000.git
cd rocket1000
# Switch to this development branch unless it has already been merged.
git checkout feature/demo-ai-mt5-integration
cp .env.example .env
# Edit .env locally: never commit it.
npm test
npm start
```

`.env` must include:

- `ROCKET1000_EA_TOKEN`: unique random secret of at least 24 characters. Run `openssl rand -hex 24` to generate one.
- `ROCKET1000_DEMO_ACCOUNT_LOGIN`: your numeric **demo** MT5 login, not your password.
- `ROCKET1000_ALLOWED_SYMBOL`: exact broker symbol, default `EURUSD`; brokers may use a suffix.
- `OPENAI_API_KEY`: server-side secret from <https://platform.openai.com/api-keys>. Do not put it into MQL5 source or frontend.
- `ROCKET1000_ENABLE_DEMO_SIGNALS=false`: leave **false** until the tests pass and you intentionally start demo simulation.
- `HOST=127.0.0.1` for a local bridge. If MT5 is remote, use a secure HTTPS reverse proxy with appropriate network restrictions; do not expose this HTTP listener publicly.

`GET http://127.0.0.1:3000/health` returns basic mode and enablement. The authenticated `POST /api/mt5/signal` endpoint is called by the EA. Its private token must never be shared with third parties.

The server writes `.rocket1000-state.json` next to the app. Run it as a **single persistent Node process on durable local storage**; **not** as a stateless serverless function. If the state file is lost, bar reservations and the server's daily equity baseline are lost (the EA also has persisted local safety checks). Back it up, and never run multiple API instances against the same state path.

## 2. Compile EA in MT5

1. In MetaTrader 5, open MetaEditor (F4), create/open an Expert Advisor file and use the contents of `mt5/rocket1000_demo_ai.mq5`.
2. Compile with F7 and inspect errors/warnings. This repository cannot verify compilation in MetaEditor.
3. In the MT5 terminal, open **Tools → Options → Expert Advisors** and allow WebRequest to your *exact* API base URL (`http://127.0.0.1:3000` for same-computer tests, or a correctly configured HTTPS URL). MT5 WebRequest is synchronous and cannot be tested in the MT5 Strategy Tester.
4. Login to a **DEMO** account. Attach the EA to that account's configured symbol/M15 chart. Set `AllowedDemoLogin` to the same demo login and `EAToken` to the same server token. Verify chart/symbol specifications and MT5 Algo Trading settings.
5. Leave `EnableDemoAutoTrading=false` in the EA and `ROCKET1000_ENABLE_DEMO_SIGNALS=false` on the server until compilation, connectivity, data and monitoring are verified.
6. Only for explicit **demo testing**, manually set `ROCKET1000_ENABLE_DEMO_SIGNALS=true` and restart the server; then set `EnableDemoAutoTrading=true` in the EA settings. **Never** do so while connected to a live account.

The EA sends one request per fully closed M15 candle, not a continuous fast-tick stream. With either toggle disabled, it submits no AI requests and no orders. Signals, even if returned by OpenAI, may be blocked by the deterministic risk engine.

## 3. Emergency stop

In MT5 press **F3** (Global Variables), create or edit the name `r1000.<your-demo-login>.STOP` and set its numeric value to **1**. New orders are blocked immediately on the next timer cycle. Turning off Algo Trading or removing the EA also halts new EA orders. **These controls do not close an existing position**; inspect and manage any existing demo position manually.

## 4. Tests

```bash
npm test
```

Tests include demo-only validation, malformed candles, stale data, spread/exposure gate, confidence/trend gate, drawdown, bearer authentication, and identical-bar deduplication with a **mocked** OpenAI response. They do not test MT5 order execution or guarantee correct broker handling. Complete separate demo forward testing and manual MT5 compilation before any production design work.

## Security and limitations

- This is a first integration, not a validated profitable strategy. Do not use on a live account.
- The API authenticates the EA via bearer token. The server's demo status is based on the EA's self-report; the EA checks the real MT5 account type independently.
- Real external events and economic news are **not** fetched, so disable automation manually during known high-impact news/events if needed.
- The AI model is called only once per eligible closed bar when both the account and market pass preflight and the server's demo signals flag is on; token charges are billed separately by OpenAI.
- Local terminal global variables and server state are used for deduplication; operate a single EA on one demo account and a single bridge server.
- Repo scaffold has no dashboard, order-close automation, live account support, audited broker adapter, or published deployment. Those require separate development and testing.
