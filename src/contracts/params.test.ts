import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBacktestParams } from './params';

const defaults = {
  entryThreshold: 2,
  holdBars: 12,
  stopLossPct: 3,
  takeProfitPct: 5,
  leverage: 4,
};

describe('parseBacktestParams', () => {
  it('accepts valid overrides', () => {
    const params = parseBacktestParams({
      entryThreshold: '0.5',
      holdBars: '500',
      stopLossPct: '0.1',
      takeProfitPct: '100',
      leverage: '20',
    }, defaults);

    assert.deepEqual(params, {
      entryThreshold: 0.5,
      holdBars: 500,
      stopLossPct: 0.1,
      takeProfitPct: 100,
      leverage: 20,
    });
  });

  it('uses defaults for omitted, null, and empty values', () => {
    const params = parseBacktestParams({
      entryThreshold: null,
      holdBars: '',
    }, defaults);

    assert.deepEqual(params, defaults);
  });

  const invalidQueries: Array<[string, Record<string, unknown>]> = [
    ['entryThreshold below its minimum', { entryThreshold: '0.49' }],
    ['holdBars below its minimum', { holdBars: '2' }],
    ['non-integer holdBars', { holdBars: '3.5' }],
    ['stopLossPct below its minimum', { stopLossPct: '0' }],
    ['takeProfitPct above its maximum', { takeProfitPct: '101' }],
    ['leverage above its maximum', { leverage: '21' }],
    ['non-finite leverage', { leverage: Infinity }],
  ];

  for (const [name, query] of invalidQueries) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => parseBacktestParams(query, defaults),
        /INVALID_BACKTEST_PARAMS/,
      );
    });
  }
});
