import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertQuotePrice,
  resolveQuoteCurrency,
} from '../public/js/header-quote.mjs';

test('keeps Binance primary header prices in USD instead of dividing by USD/KRW again', () => {
  const data = {
    source: 'binance',
    m5: {
      source: 'binance',
      dataSource: 'binance',
      meta: { currency: 'USD', price: 1186.5 },
    },
  };

  const quoteCurrency = resolveQuoteCurrency(data.m5, data.m5.meta);
  const displayPrice = convertQuotePrice(1186.5, {
    fromCurrency: quoteCurrency,
    toCurrency: 'USD',
    krwUsdRate: 1500,
  });

  assert.equal(quoteCurrency, 'USD');
  assert.equal(displayPrice, 1186.5);
});

test('converts Korean spot header prices from KRW to USD', () => {
  const data = {
    source: 'naver',
    m5: {
      source: 'naver',
      meta: { currency: 'KRW', price: 1_800_000 },
    },
  };

  const quoteCurrency = resolveQuoteCurrency(data.m5, data.m5.meta);
  const displayPrice = convertQuotePrice(1_800_000, {
    fromCurrency: quoteCurrency,
    toCurrency: 'USD',
    krwUsdRate: 1500,
  });

  assert.equal(quoteCurrency, 'KRW');
  assert.equal(displayPrice, 1200);
});

test('converts Binance header prices to KRW when KRW display is selected', () => {
  const displayPrice = convertQuotePrice(1186.5, {
    fromCurrency: 'USD',
    toCurrency: 'KRW',
    krwUsdRate: 1500,
  });

  assert.equal(displayPrice, 1_779_750);
});
