import assert from 'node:assert/strict';
import test from 'node:test';
import { extendFlatCandlesToNow } from './candles';

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
