const VALID_SOURCES = ['naver', 'yahoo', 'binance'];

export function getVisibleOverlaySources(selectedSources) {
  const selected = Array.isArray(selectedSources) ? selectedSources : [];
  const visible = selected.filter((source, index) => (
    VALID_SOURCES.includes(source) && selected.indexOf(source) === index
  ));
  return visible.length ? visible : ['naver'];
}

export function convertSeriesPrice(value, fromCurrency, toCurrency, krwUsdRate) {
  const price = Number(value);
  if (!Number.isFinite(price)) return 0;
  const from = String(fromCurrency || 'KRW').toUpperCase() === 'USD' ? 'USD' : 'KRW';
  const to = String(toCurrency || 'USD').toUpperCase() === 'KRW' ? 'KRW' : 'USD';
  const fx = Number(krwUsdRate);

  if (from === to) return to === 'KRW' ? Math.round(price) : +price.toFixed(2);
  if (!Number.isFinite(fx) || fx <= 0) return to === 'KRW' ? Math.round(price) : +price.toFixed(2);
  if (from === 'KRW' && to === 'USD') return +(price / fx).toFixed(2);
  return Math.round(price * fx);
}

export function lineFromCandles(candles, { fromCurrency, toCurrency, krwUsdRate }) {
  if (!Array.isArray(candles)) return [];
  return candles
    .filter((candle) => candle && Number.isFinite(Number(candle.time)) && Number.isFinite(Number(candle.close)))
    .map((candle) => ({
      time: candle.time,
      value: convertSeriesPrice(candle.close, fromCurrency, toCurrency, krwUsdRate),
    }));
}

export function lineFromBinance(frame, { toCurrency, krwUsdRate }) {
  const line = Array.isArray(frame?.line) && frame.line.length
    ? frame.line.map((point) => ({ time: point.time, close: point.value }))
    : frame?.candles || [];
  return lineFromCandles(line, {
    fromCurrency: 'USD',
    toCurrency,
    krwUsdRate,
  });
}
