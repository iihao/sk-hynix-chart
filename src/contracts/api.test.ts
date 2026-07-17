import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBacktestResponse,
  parseFactorsResponse,
  parseIndicatorsResponse,
} from './validators';

describe('dashboard API contracts', () => {
  it('accepts the production indicators shape', () => {
    const value = parseIndicatorsResponse({
      rsi: [45],
      macd: { dif: [1], dea: [0.5], histogram: [1] },
      bollinger: { upper: [110], mid: [100], lower: [90] },
      ma5: [101],
      ma20: [100],
      volRatio: [1.2],
      latest: {
        rsi: 45,
        macdDif: 1,
        macdDea: 0.5,
        macdHist: 1,
        volRatio: 1.2,
        ma5: 101,
        ma20: 100,
        bollUpper: 110,
        bollLower: 90,
        macdState: 'bullish',
      },
      signals: [],
      support: [],
      resistance: [],
      times: [1],
    });
    assert.equal(value.latest?.rsi, 45);
  });

  it('accepts an empty indicators response', () => {
    const value = parseIndicatorsResponse({
      rsi: [],
      macd: { dif: [], dea: [], histogram: [] },
      bollinger: { upper: [], mid: [], lower: [] },
      ma5: [],
      ma20: [],
      volRatio: [],
      latest: null,
      signals: [],
      support: [],
      resistance: [],
      times: [],
    });
    assert.equal(value.latest, null);
  });

  it('accepts the production factor shape', () => {
    const value = parseFactorsResponse({
      factors: [
        { category: 'momentum', label: 'Momentum', score: 2, weight: 0.9, detail: 'up' },
      ],
      composite: 2,
      direction: 'long',
      confidence: 30,
    });
    assert.equal(value.direction, 'long');
  });

  it('accepts production backtest metric and trade names', () => {
    const value = parseBacktestResponse({
      params: {
        tf: '5m',
        entryThreshold: 2,
        holdBars: 12,
        stopLossPct: 3,
        takeProfitPct: 5,
        leverage: 5,
      },
      metrics: {
        totalReturn: 1,
        winRate: 40,
        profitFactor: 1.2,
        sharpeRatio: 0.3,
        maxDrawdown: 2,
        totalTrades: 5,
        avgHoldBars: 4,
        avgWin: 2,
        avgLoss: 1,
        expectancy: 0.2,
      },
      trades: [
        {
          entryTime: 1,
          exitTime: 2,
          entryPrice: 100,
          exitPrice: 102,
          direction: 'long',
          pnlPct: 2,
          pnl: 10,
          exitReason: 'time_exit',
          bars: 4,
          positionSizePct: 30,
          sl: 98,
          tp: 104,
        },
      ],
      equityCurve: [{ time: 1, equity: 10000 }],
      factorHistory: [],
      activeWeights: {},
      activeParams: {},
    });
    assert.equal(value.metrics?.sharpeRatio, 0.3);
  });

  it('accepts the domain backtest response shape', () => {
    const value = parseBacktestResponse({
      metrics: {
        totalReturn: 1,
        winRate: 40,
        profitFactor: 1.2,
        sharpe: 0.3,
        maxDrawdown: 2,
        totalTrades: 5,
        avgWin: 2,
        avgLoss: 1,
      },
      trades: [{ entry: 100, exit: 102, pnl: 10, pnlPct: 2, direction: 'long' }],
      equityCurve: [10000, 10010],
      factorHistory: [],
      weights: {},
    });
    assert.equal(value.metrics?.sharpe, 0.3);
  });

  it('rejects malformed factor responses', () => {
    assert.throws(() => parseFactorsResponse({ factors: 'bad' }));
  });
});
