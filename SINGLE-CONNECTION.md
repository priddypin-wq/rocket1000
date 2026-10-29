# One private app connection, one EA installation, one MT5 terminal

This connection-only repair preserves the existing screens, buttons, navigation,
styles, backend origin, installed credentials and trading safeguards.

- All screens use the same private HttpOnly browser session. Same-origin browser
  locks serialize first-time initialization across tabs. Browsers without this
  feature may reuse an existing session but cannot race to create replacements.
- A session authentication failure never replays an action or silently creates
  a new empty workspace. OpenAI authentication errors cannot reset MT5 identity.
- Each installation is bound to its persistent MT5 terminal. A competing copy
  cannot replace account identity, chart registration, market data, execution
  state or trading permission. Pre-upgrade terminal identities are preserved.
- The original terminal/chart can register a new session after a restart. A new
  chart on that terminal can register after the prior chart has been silent for
  more than 90 seconds. Moving to another terminal requires the existing explicit
  installation-replacement flow; ordinary downloads preserve the credential.
- Previously revoked credentials cannot stop a replacement installation.
- Home, Market and MT5 share a 30-second connection freshness deadline. Broker
  disconnection immediately makes retained analysis stale. Expired, revoked,
  mismatched or invalid execution data cannot appear connected on another page.

Separate browser profiles remain private and cannot read someone else's broker
connection. This repair does not expose a global public account or session token.

## Verification

Controlled tests exercise concurrent tabs, session loss, provider authentication
errors, competing terminals/charts, reconnection, credential replacement, rejected
packet isolation and matching status across pages. The HTTP suite checks the
actual application routes with isolated database/terminal fixtures. These are not
evidence of a genuine broker connection or filled orders.

Validated for this repair: 480 automated tests, 60 HTTP checks, ESLint with zero
warnings, TypeScript checking and the Next.js production build. The compiled EA
source/binary integrity check passes; neither artifact was changed.

The migration adds only `rocket_ea_connection_binding`; it does not replace
credentials, rebind an account, grant trading permission or modify broker orders.
The existing EA protocol and compiled binary are unchanged.

External acceptance still requires the installed EA to send a real heartbeat
from MT5. Paid AI availability and genuine broker execution remain separate
acceptance checks. No broker orders or live activation are part of this repair.
