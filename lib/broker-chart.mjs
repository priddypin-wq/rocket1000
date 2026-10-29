// Geometry consumes reported closed candles verbatim. Gaps remain gaps; no
// resampling, invented current candle, default symbols or external price feed.
export function candleGeometry(
  chart,
  timeframe,
  { limit = 80, width = 720, height = 300 } = {},
) {
  if (
    !chart?.closedCandles ||
    !Array.isArray(chart.timeframes?.[timeframe]?.bars)
  )
    return null;
  const bars = chart.timeframes[timeframe].bars.slice(-limit);
  if (!bars.length) return null;
  if (
    bars.some(
      (b, i) =>
        ![b.time, b.open, b.high, b.low, b.close, b.volume].every(
          Number.isFinite,
        ) ||
        b.time <= 0 ||
        b.low <= 0 ||
        b.high < Math.max(b.open, b.close, b.low) ||
        b.low > Math.min(b.open, b.close) ||
        b.volume < 0 ||
        (i > 0 && b.time <= bars[i - 1].time),
    )
  )
    return null;
  const left = 16,
    right = width - 92,
    top = 16,
    bottom = height - 38;
  const prices = bars.flatMap((b) => [b.low, b.high]);
  if ([chart.bid, chart.ask].every(Number.isFinite))
    prices.push(chart.bid, chart.ask);
  const low = Math.min(...prices),
    high = Math.max(...prices);
  const padding = Math.max(
    (high - low) * 0.08,
    Math.abs(high) * 0.00001,
    Number.EPSILON,
  );
  const min = low - padding,
    max = high + padding;
  const from = bars[0].time,
    to = bars.at(-1).time;
  const x = (time) =>
    left + 5 + ((time - from) / (to - from || 1)) * (right - left - 10);
  const y = (price) => bottom - ((price - min) / (max - min)) * (bottom - top);
  const spacing =
    bars.length > 1
      ? Math.min(...bars.slice(1).map((b, i) => x(b.time) - x(bars[i].time)))
      : 10;
  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    from,
    to,
    min,
    max,
    candles: bars.map((bar) => ({
      ...bar,
      x: x(bar.time),
      wickTop: y(bar.high),
      wickBottom: y(bar.low),
      bodyTop: y(Math.max(bar.open, bar.close)),
      bodyBottom: y(Math.min(bar.open, bar.close)),
      bodyWidth: Math.max(1, Math.min(8, spacing * 0.65)),
      rising: bar.close >= bar.open,
    })),
    ticks: Array.from({ length: 4 }, (_, i) => {
      const price = min + ((max - min) * i) / 3;
      return { price, y: y(price) };
    }),
    quotes: ["bid", "ask"]
      .filter((key) => Number.isFinite(chart[key]))
      .map((key) => ({
        label: key,
        price: chart[key],
        y: y(chart[key]),
      })),
  };
}

export function chartIsFresh(report, elapsedMs) {
  return !!(
    report?.connection?.fresh &&
    report.chart?.closedCandles &&
    Number.isFinite(report.generatedAt) &&
    Number.isFinite(report.chart.freshUntil) &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0 &&
    report.generatedAt + elapsedMs < report.chart.freshUntil
  );
}

export function brokerClock(value, seconds = false) {
  if (!Number.isFinite(value) || value <= 0) return "Not reported";
  const date = new Date(value * (seconds ? 1000 : 1));
  return Number.isNaN(date.getTime())
    ? "Not reported"
    : date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}
