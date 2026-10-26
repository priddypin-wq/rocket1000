import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.mjs";
import { createAiResponse, configuredModel } from "./ai-provider.mjs";
import { disableTrading } from "./trading.mjs";

export const aiUsageSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_ai_usage (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,day_bucket BIGINT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,reserved_microusd BIGINT NOT NULL,charged_microusd BIGINT NOT NULL DEFAULT 0,input_tokens BIGINT NOT NULL DEFAULT 0,output_tokens BIGINT NOT NULL DEFAULT 0,created_at BIGINT NOT NULL,settled_at BIGINT,FOREIGN KEY(user_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS rocket_ai_usage_day_idx ON rocket_ai_usage(user_id,day_bucket)`,
];
// Standard non-cached text rates, USD per million tokens; reviewed 2026-10-22.
// Unknown models need explicit operator rates; they never inherit another price.
const prices = {
  "gpt-6.1-sol": [2, 10],
  "gpt-5-mini": [0.25, 2],
  "gpt-5.4": [2.5, 15],
};
export function tokenPrices(model, env = process.env) {
  const explicit = [
    env.ROCKET_AI_INPUT_USD_PER_MILLION,
    env.ROCKET_AI_OUTPUT_USD_PER_MILLION,
  ];
  const rates = explicit.every((v) => v !== undefined && v !== "")
    ? explicit.map(Number)
    : prices[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!rates || !rates.every((v) => Number.isFinite(v) && v > 0 && v <= 1000))
    throw new ApiError(
      503,
      "Configure verified token prices for the selected OpenAI model before using it.",
      "AI_PRICING_REQUIRED",
    );
  return rates;
}
export const defaultDailyBudget = (env = process.env) => {
  const amount = Number(env.ROCKET_AI_DAILY_BUDGET_USD || 2);
  return Number.isFinite(amount) && amount >= 0.1 && amount <= 10 ? amount : 2;
};
export function usageService(
  db,
  { now = Date.now, env = process.env, provider = createAiResponse } = {},
) {
  async function suspend(uid, error, expectedRun) {
    await db.transaction(async (tx) => {
      const [c] = await tx.query(
        `SELECT id FROM rocket_direct_connections WHERE user_id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [uid],
      );
      if (!c) return;
      const [engine] = await tx.query(
        "SELECT run_id FROM rocket_analysis_engine WHERE connection_id=?",
        [c.id],
      );
      if ((engine?.run_id || null) !== expectedRun) return;
      const reason =
        error instanceof ApiError
          ? error.message
          : "OpenAI request failed. Verify the connection and restart explicitly.";
      await tx.query(
        "UPDATE rocket_analysis_engine SET state='suspended',run_id=?,lease_until=0,reason=? WHERE connection_id=?",
        [randomUUID(), reason, c.id],
      );
      await tx.query(
        "UPDATE rocket_analyses SET status='cancelled',completed_at=?,error=? WHERE connection_id=? AND status='analyzing'",
        [now(), reason, c.id],
      );
      await disableTrading(tx, c.id, now());
      await tx.query(
        "UPDATE rocket_engine_activation SET next_attempt=?,lease_until=0,reason=? WHERE connection_id=? AND paused=0",
        [now() + 300000, reason, c.id],
      );
    });
  }
  async function totals(uid, tx = db) {
    const [row] = await tx.query(
      `SELECT COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(charged_microusd),0) AS charged,COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_microusd ELSE 0 END),0) AS reserved,COUNT(*) AS requests FROM rocket_ai_usage WHERE user_id=? AND day_bucket=?`,
      [uid, Math.floor(now() / 86400000)],
    );
    const [engine] = await tx.query(
      "SELECT daily_budget_microusd FROM rocket_analysis_engine WHERE connection_id IN (SELECT id FROM rocket_direct_connections WHERE user_id=?)",
      [uid],
    );
    return {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      estimatedUsd: Number(row.charged) / 1e6,
      reservedUsd: Number(row.reserved) / 1e6,
      requests: Number(row.requests),
      dailyBudgetUsd: engine
        ? Number(engine.daily_budget_microusd) / 1e6
        : defaultDailyBudget(env),
      estimateOnly: true,
      period: "UTC day",
      caveat:
        "App-enforced reservations cover requests made by this app. Provider invoices, price changes and use of this key elsewhere are separate.",
    };
  }
  async function reserve(uid, payload, requestEnv, kind) {
    const model = configuredModel(requestEnv),
      rates = tokenPrices(model, requestEnv);
    // Text-only requests, no tools/files/images. UTF-8 bytes plus schema/framing
    // overhead conservatively bound the tokenizer input. No cached-price discount.
    if (
      payload.tools ||
      payload.previous_response_id ||
      typeof payload.input !== "string"
    )
      throw new ApiError(
        400,
        "Only bounded text analysis requests are permitted.",
        "AI_REQUEST_REJECTED",
      );
    const inputBound =
      Buffer.byteLength(JSON.stringify(payload), "utf8") + 4096;
    const outputBound = payload.max_output_tokens;
    if (
      inputBound > 150000 ||
      !Number.isInteger(outputBound) ||
      outputBound < 1 ||
      outputBound > 4000
    )
      throw new ApiError(
        413,
        "AI analysis exceeds the configured request allowance.",
        "AI_REQUEST_TOO_LARGE",
      );
    const amount = Math.ceil(inputBound * rates[0] + outputBound * rates[1]);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        `SELECT id FROM rocket_workspaces WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [uid],
      );
      const spent = await totals(uid, tx);
      if (
        Math.round((spent.estimatedUsd + spent.reservedUsd) * 1e6) + amount >
        Math.floor(spent.dailyBudgetUsd * 1e6)
      )
        throw new ApiError(
          429,
          "Daily AI usage budget reached. Analysis and new automated orders are suspended.",
          "AI_BUDGET_REACHED",
        );
      await tx.query(
        "INSERT INTO rocket_ai_usage(id,user_id,day_bucket,kind,model,status,reserved_microusd,created_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          id,
          uid,
          Math.floor(now() / 86400000),
          kind,
          model,
          "reserved",
          amount,
          now(),
        ],
      );
    });
    return { id, amount, rates, inputBound, outputBound };
  }
  async function settle(reservation, usage) {
    const input = usage?.input_tokens,
      output = usage?.output_tokens;
    const valid =
      Number.isInteger(input) &&
      input >= 0 &&
      Number.isInteger(output) &&
      output >= 0 &&
      input <= reservation.inputBound &&
      output <= reservation.outputBound;
    const charged = valid
      ? Math.ceil(input * reservation.rates[0] + output * reservation.rates[1])
      : reservation.amount;
    await db.query(
      "UPDATE rocket_ai_usage SET status=?,charged_microusd=?,input_tokens=?,output_tokens=?,settled_at=? WHERE id=? AND status='reserved'",
      [
        valid ? "completed" : "unverified",
        charged,
        valid ? input : 0,
        valid ? output : 0,
        now(),
        reservation.id,
      ],
    );
    return valid;
  }
  function responder(uid, kind = "analysis", { runId, beforeDispatch } = {}) {
    return async (payload, options = {}) => {
      const requestEnv = options.env || env;
      const [current] = await db.query(
        "SELECT run_id FROM rocket_analysis_engine WHERE connection_id IN (SELECT id FROM rocket_direct_connections WHERE user_id=?)",
        [uid],
      );
      const generation = runId || current?.run_id || null;
      let r;
      try {
        r = await reserve(uid, payload, requestEnv, kind);
      } catch (error) {
        await suspend(uid, error, generation);
        throw error;
      }
      if (beforeDispatch) {
        try {
          await db.transaction(beforeDispatch);
        } catch (error) {
          await db.query(
            "UPDATE rocket_ai_usage SET status='cancelled',settled_at=? WHERE id=? AND status='reserved'",
            [now(), r.id],
          );
          throw error;
        }
      }
      let result;
      try {
        result = await provider(
          { ...payload, service_tier: "default" },
          options,
        );
      } catch (error) {
        await settle(r, null);
        await suspend(uid, error, generation);
        throw error;
      }
      if (!(await settle(r, result?.usage))) {
        const failure = new ApiError(
          503,
          "OpenAI usage could not be verified. The full request allowance was charged locally; analysis is suspended.",
          "AI_USAGE_UNVERIFIED",
        );
        await suspend(uid, failure, generation);
        throw failure;
      }
      return result;
    };
  }
  return { totals, reserve, settle, responder };
}
