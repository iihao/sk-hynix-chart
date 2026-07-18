export function normalizeCurrency(currency) {
  const normalized = String(currency || '').trim().toUpperCase();
  if (normalized === 'USDT' || normalized === 'USD') return 'USD';
  if (normalized === 'KRW') return 'KRW';
  return '';
}

export function resolveQuoteCurrency(frame = {}, meta = {}) {
  const explicitCurrency = normalizeCurrency(meta.currency || frame.currency);
  if (explicitCurrency) return explicitCurrency;

  const source = String(frame.dataSource || frame.source || '').toLowerCase();
  if (source === 'binance') return 'USD';
  return 'KRW';
}

export function convertQuotePrice(value, { fromCurrency, toCurrency, krwUsdRate }) {
  const price = Number(value);
  if (!Number.isFinite(price)) return 0;

  const from = normalizeCurrency(fromCurrency) || 'KRW';
  const to = normalizeCurrency(toCurrency) || 'USD';
  const fx = Number(krwUsdRate);
  if (from === to) return to === 'KRW' ? Math.round(price) : +price.toFixed(2);

  if (!Number.isFinite(fx) || fx <= 0) {
    return to === 'KRW' ? Math.round(price) : +price.toFixed(2);
  }

  if (from === 'USD' && to === 'KRW') return Math.round(price * fx);
  if (from === 'KRW' && to === 'USD') return +(price / fx).toFixed(2);

  return to === 'KRW' ? Math.round(price) : +price.toFixed(2);
}
