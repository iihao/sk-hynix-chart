import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBacktestQuery,
  normalizeBacktest,
  normalizeFactors,
  normalizeIndicators,
  resolveResponseSource,
} from '../public/js/dashboard-data.mjs';

test('normalizes indicator latest values', () => {
  const result = normalizeIndicators({
    latest: { rsi: 45, macdHist: 1.2, volRatio: 1.1 },
  });

  assert.deepEqual(result, { rsi: 45, macdHist: 1.2, volRatio: 1.1 });
});

test('normalizes factor direction for display', () => {
  const result = normalizeFactors({
    factors: [],
    composite: -2.5,
    direction: 'short',
    confidence: 55,
  });

  assert.deepEqual(result.direction, {
    code: 'short',
    label: '做空',
    score: -2.5,
    confidence: 55,
  });
});

test('uses production backtest query names', () => {
  const query = buildBacktestQuery({
    threshold: 2,
    hold: 12,
    stopLoss: 3,
    takeProfit: 5,
    optimize: false,
  });

  assert.equal(
    query.toString(),
    'entryThreshold=2&holdBars=12&stopLossPct=3&takeProfitPct=5&optimize=false',
  );
});

test('does not multiply server win rate and maps trade prices', () => {
  const result = normalizeBacktest({
    metrics: { winRate: 39.7, totalReturn: 1, sharpeRatio: 0.2 },
    trades: [
      { entryPrice: 100, exitPrice: 101, pnl: 5, pnlPct: 0.5, direction: 'long' },
    ],
    activeWeights: { momentum: 0.9 },
  });

  assert.equal(result.metrics.winRate, 39.7);
  assert.equal(result.metrics.sharpe, 0.2);
  assert.equal(result.trades[0].entry, 100);
  assert.equal(result.trades[0].exit, 101);
  assert.equal(result.trades[0].pnlPct, 0.5);
  assert.deepEqual(result.weights, { momentum: 0.9 });
});

test('preserves backtest error payloads', () => {
  const result = normalizeBacktest({
    error: '数据不足',
    metrics: null,
    trades: [],
  });

  assert.equal(result.error, '数据不足');
  assert.equal(result.metrics, null);
});

test('normalizes the domain backtest response shape', () => {
  const result = normalizeBacktest({
    metrics: { winRate: 50, totalReturn: 2, sharpe: 0.4 },
    trades: [{ entry: 100, exit: 102, pnl: 10, pnlPct: 2, direction: 'long' }],
    weights: { momentum: 0.8 },
  });
  assert.equal(result.metrics.sharpe, 0.4);
  assert.equal(result.trades[0].entry, 100);
  assert.deepEqual(result.weights, { momentum: 0.8 });
});

test('uses a valid fallback response source', () => {
  assert.equal(resolveResponseSource('yahoo', { source: 'naver' }), 'naver');
  assert.equal(resolveResponseSource('naver', { source: 'invalid' }), 'naver');
});
