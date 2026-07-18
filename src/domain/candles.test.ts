import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContinuousSpotCandles, extendFlatCandlesToNow } from './candles';

test('extends closed-market spot candles as a flat fixed line', () => {
  const candles = [
    { time: 1000, open: 180000, high: 180000, low: 180000, close: 180000, volume: 0, sampleCount: 1 },
  ];

  const result = extendFlatCandlesToNow(candles, {
    nowSec: 1180,
    intervalSec: 60,
    price: 180000,
  });

  assert.deepEqual(result.map((c) => c.time), [1000, 1060, 1120]);
  assert.deepEqual(result.map((c) => c.close), [180000, 180000, 180000]);
});

test('does not duplicate the current candle bucket when flat line is already current', () => {
  const candles = [
    { time: 1140, open: 180000, high: 180000, low: 180000, close: 180000, volume: 0, sampleCount: 1 },
  ];

  const result = extendFlatCandlesToNow(candles, {
    nowSec: 1180,
    intervalSec: 60,
    price: 180000,
  });

  assert.equal(result.length, 1);
});

test('builds a continuous closed-market line from the last spot candle', () => {
  const result = buildContinuousSpotCandles({
    candles: [
      { time: 1000, open: 180000, high: 180000, low: 180000, close: 180000, volume: 0, sampleCount: 1 },
    ],
    nowSec: 1180,
    intervalSec: 60,
    spotPrice: 181000,
    fallbackPrice: 170000,
  });

  assert.equal(result.source, 'spot-flat');
  assert.deepEqual(result.candles.map((c) => c.time), [1000, 1060, 1120]);
  assert.deepEqual(result.candles.map((c) => c.close), [180000, 180000, 180000]);
});

test('builds a continuous closed-market line from Binance fallback when spot history is empty', () => {
  const result = buildContinuousSpotCandles({
    candles: [],
    nowSec: 1180,
    intervalSec: 60,
    spotPrice: null,
    fallbackPrice: 170000,
  });

  assert.equal(result.source, 'binance-fallback');
  assert.deepEqual(result.candles, [
    { time: 1140, open: 170000, high: 170000, low: 170000, close: 170000, volume: 0, sampleCount: 0 },
  ]);
});
