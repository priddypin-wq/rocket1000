import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { POLICY, validateSnapshot, marketFeatures, deterministicGate, dailyLossGate } from "./risk.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const MODEL = "gpt-6.1-sol";
const ALLOWED_SYMBOL = process.env.ROCKET1000_ALLOWED_SYMBOL ?? "EURUSD";
const DEMO_LOGIN = Number(process.env.ROCKET1000_DEMO_ACCOUNT_LOGIN ?? 0);
const EA_TOKEN = process.env.ROCKET1000_EA_TOKEN ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ENABLED = process.env.ROCKET1000_ENABLE_DEMO_SIGNALS === "true";
const STATE_PATH = resolve(process.env.ROCKET1000_STATE_PATH ?? ".rocket1000-state.json");

function readState() {
  if (!existsSync(STATE_PATH)) return { accounts: {} };
  const value = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  if (!value || typeof value.accounts !== "object" || Array.isArray(value.accounts)) {
    throw new Error("Invalid persisted trading state; refusing to start");
  }
  return value;
}
const state = readState();
function persistState() {
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, STATE_PATH);
}

function equalToken(provided) {
  if (!EA_TOKEN || !provided || provided.length > 512) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(EA_TOKEN).digest();
  return timingSafeEqual(a, b);
}

function reply(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}
function wait(reason, barTime = null) {
  return { action: "WAIT", barTime, reason };
}
async function readJSON(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw) > 65536) throw new Error("Payload too large");
  }
  return JSON.parse(raw);
}

const schema = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["BUY", "SELL", "WAIT"] },
    confidence: { type: "number" },
    reason: { type: "string" }
  },
  required: ["action", "confidence", "reason"]
};

async function aiSignal(snapshot, features) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${OPENAI_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        reasoning: { effort: "low" },
        max_output_tokens: 800,
        store: false,
        instructions: [
          "You are an extremely conservative DEMO-ONLY technical signal assessor.",
          "Use ONLY the supplied closed candles and features. Never assume news or external data.",
          "Return WAIT on ambiguity, range-bound conditions, insufficient evidence or poor reward/risk.",
          "The response is a recommendation, not an order. No position sizing or account instructions.",
          "Keep reason under 120 characters. Output only the requested schema."
        ].join(" "),
        input: JSON.stringify({
          symbol: snapshot.symbol, timeframe: snapshot.timeframe,
          spreadPoints: snapshot.spreadPoints,
          features, candles: snapshot.candles.slice(-40)
        }),
        text: { format: { type: "json_schema", name: "demo_signal", strict: true, schema } }
      })
    });
    if (!response.ok) throw new Error(`OpenAI returned HTTP ${response.status}`);
    const data = await response.json();
    if (data.status !== "completed") throw new Error("Model response incomplete");
    const output = (data.output ?? []).flatMap(x => x.content ?? [])
      .filter(x => x.type === "output_text").map(x => x.text).join("");
    if (!output) throw new Error("Empty model output");
    const value = JSON.parse(output);
    if (!["BUY", "SELL", "WAIT"].includes(value.action) ||
        typeof value.confidence !== "number" || !Number.isFinite(value.confidence) ||
        typeof value.reason !== "string") throw new Error("Model output failed validation");
    return value;
  } finally {
    clearTimeout(timer);
  }
}

async function signal(snapshot) {
  // The EA checks ACCOUNT_TRADE_MODE independently. This server rejects non-demo reports,
  // but cannot independently attest an account's broker mode.
  if (!ENABLED) return wait("Server demo signals disabled");
  if (!EA_TOKEN || !OPENAI_KEY || !Number.isSafeInteger(DEMO_LOGIN) || DEMO_LOGIN <= 0) {
    return wait("Missing server-side demo configuration");
  }
  const issue = validateSnapshot(snapshot, ALLOWED_SYMBOL);
  if (issue) return wait(issue);
  if (snapshot.accountLogin !== DEMO_LOGIN) return wait("Account not allowlisted");
  const features = marketFeatures(snapshot);
  const barTime = features.barTime;
  const day = new Date().toISOString().slice(0, 10); // UTC session boundary
  const key = String(snapshot.accountLogin);
  const prev = state.accounts[key] ?? {};
  const startEquity = prev.day === day ? prev.startEquity : snapshot.equity;
  const lossIssue = dailyLossGate(snapshot.equity, startEquity);
  if (lossIssue) return wait(lossIssue, barTime);
  if (prev.day === day && Number.isSafeInteger(prev.lastBarTime) && barTime <= prev.lastBarTime) {
    return wait("Already processed this closed bar", barTime);
  }

  // Reserve the bar and persist it BEFORE calling the model, preventing concurrent and
  // restart-triggered duplicate signals. Failed AI calls never retry a reserved bar.
  state.accounts[key] = { day, startEquity, lastBarTime: barTime };
  persistState();

  if (features.atr14 < POLICY.minAtrPoints * snapshot.point) return wait("Insufficient volatility", barTime);
  let decision;
  try {
    decision = await aiSignal(snapshot, features);
  } catch (err) {
    console.error("AI analysis failed:", err.message);
    return wait("AI unavailable; fail closed", barTime);
  }
  const gate = deterministicGate(snapshot, features, decision.action, decision.confidence);
  if (gate) return wait(gate, barTime);
  return {
    action: decision.action,
    barTime,
    confidence: decision.confidence,
    reason: decision.reason.slice(0, 120),
    // Deliberately no price or lot size. The EA independently checks broker rules and sizes risk.
    model: MODEL
  };
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      return reply(res, 200, { name: "rocket1000-demo-bridge", mode: "DEMO_ONLY", enabled: ENABLED });
    }
    if (req.method !== "POST" || req.url !== "/api/mt5/signal") {
      return reply(res, 404, { error: "Not found" });
    }
    const bearer = (req.headers.authorization ?? "").match(/^Bearer (.+)$/);
    if (!equalToken(bearer?.[1])) return reply(res, 401, { error: "Unauthorised" });
    try {
      const snapshot = await readJSON(req);
      return reply(res, 200, await signal(snapshot));
    } catch (err) {
      console.error("Snapshot request rejected:", err.message);
      return reply(res, 400, wait("Invalid request or internal guard failure"));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!EA_TOKEN || EA_TOKEN.length < 24) {
    console.error("Set ROCKET1000_EA_TOKEN to a random 24+ character secret.");
    process.exit(1);
  }
  createServer().listen(PORT, HOST, () => {
    console.log(`rocket1000 DEMO bridge listening on ${HOST}:${PORT}; AI signals ${ENABLED ? "enabled" : "disabled"}`);
  });
}
