import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertSeriesPrice,
  getVisibleOverlaySources,
  lineFromCandles,
} from '../public/js/chart-overlays.mjs';

test('defaults chart overlays to Naver spot and Binance futures', () => {
  assert.deepEqual(getVisibleOverlaySources(['naver', 'binance']), ['naver', 'binance']);
});

test('converts source prices according to their native currency', () => {
  assert.equal(convertSeriesPrice(1800000, 'KRW', 'USD', 1500), 1200);
  assert.equal(convertSeriesPrice(1200, 'USD', 'USD', 1500), 1200);
  assert.equal(convertSeriesPrice(1200, 'USD', 'KRW', 1500), 1800000);
});

test('builds overlay line data from candles', () => {
  const line = lineFromCandles([
    {time: 1, close: 1800000},
    {time: 2, close: 1801500},
  ], {
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    krwUsdRate: 1500,
  });

  assert.deepEqual(line, [
    {time: 1, value: 1200},
    {time: 2, value: 1201},
  ]);
});
