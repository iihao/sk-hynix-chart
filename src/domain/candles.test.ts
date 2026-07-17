import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpotCandles } from './candles';

test('keeps flat spot candles flat and separates sample count from volume', () => {
  const candles = buildSpotCandles([{ ts: 60, price: 100 }], 60);
  assert.deepEqual(candles, [{
    time: 60, open: 100, high: 100, low: 100, close: 100, volume: 0, sampleCount: 1,
  }]);
});

test('aggregates observed prices without inventing highs or lows', () => {
  const candles = buildSpotCandles([
    { ts: 60, price: 100 },
    { ts: 70, price: 102 },
    { ts: 120, price: 101 },
  ], 60);
  assert.deepEqual(candles, [
    { time: 60, open: 100, high: 102, low: 100, close: 102, volume: 0, sampleCount: 2 },
    { time: 120, open: 101, high: 101, low: 101, close: 101, volume: 0, sampleCount: 1 },
  ]);
});
