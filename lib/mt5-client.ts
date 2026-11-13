import { createMt5Client } from "./mt5-session-client.mjs";

// Every screen shares this client and its existing private browser connection.
const client = createMt5Client();
export const privateBrowserSession = client.privateBrowserSession;
export const mt5Api = client.mt5Api;
