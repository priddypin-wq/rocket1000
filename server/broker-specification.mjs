import { ApiError } from "./errors.mjs";

const validSeconds = (value) =>
  Number.isInteger(value) && value >= 0 && value < 86400;
const validMargin = (value) =>
  value === null || (Number.isFinite(value) && value >= 0);

export function validateBrokerSpecification(value) {
  const invalid = () =>
    new ApiError(422, "Invalid broker symbol specification.");
  if (
    !value ||
    typeof value.symbol !== "string" ||
    !/^\S{1,40}$/.test(value.symbol)
  )
    throw invalid();
  const { symbol, sessions, swap, minimumBuyMargin, minimumSellMargin } = value;
  if (
    sessions !== null &&
    (!Array.isArray(sessions) ||
      !sessions.length ||
      sessions.length > 224 ||
      sessions.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== 4 ||
          !Number.isInteger(row[0]) ||
          row[0] < 0 ||
          row[0] > 6 ||
          !validSeconds(row[1]) ||
          !validSeconds(row[2]) ||
          typeof row[3] !== "boolean",
      ))
  )
    throw invalid();
  if (
    swap !== null &&
    (!swap ||
      !Number.isInteger(swap.mode) ||
      swap.mode < 0 ||
      swap.mode > 100 ||
      !Number.isFinite(swap.long) ||
      !Number.isFinite(swap.short))
  )
    throw invalid();
  if (!validMargin(minimumBuyMargin) || !validMargin(minimumSellMargin))
    throw invalid();
  return {
    symbol,
    sessions: sessions?.map((row) => [...row]) ?? null,
    swap: swap ? { mode: swap.mode, long: swap.long, short: swap.short } : null,
    minimumBuyMargin,
    minimumSellMargin,
  };
}
