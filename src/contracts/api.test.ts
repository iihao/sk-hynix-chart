import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBacktestResponse,
  parseFactorsResponse,
  parseIndicatorsResponse,
  parseQualityResponse,
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
      rawConfidence: 65,
      backtestCalibration: {
        winRate: 55,
        profitProbability: 52.5,
        sampleTrades: 10,
        source: 'active-backtest',
        totalReturn: 3,
        maxDrawdown: 1,
        sharpe: 0.8,
        updatedAt: null,
        note: '参考',
      },
      confidenceCalibration: {
        rawConfidence: 65,
        confidence: 30,
        backtestProbability: 52.5,
        sampleTrades: 10,
        factorAgreement: 0.7,
        indicatorAgreement: 0.6,
        penalties: ['sample'],
        note: '参考',
        debug: {
          rawScore: 12,
          backtestScore: 10,
          sampleScore: 5,
          performanceScore: 4,
          drawdownScore: 8,
          sharpeScore: 5,
          factorScore: 6,
          indicatorScore: 4,
          signalBonus: 2,
          penaltyDetails: [],
          formula: 'raw + backtest',
        },
      },
      timeframeProfile: {
        tf: 'm5',
        label: '5m 主决策',
        role: 'trade',
        decisionWeight: 0.45,
        minSampleTrades: 20,
        params: { entryThreshold: 0.5, holdBars: 12 },
        calibration: {
          winRate: 55,
          profitProbability: 52.5,
          sampleTrades: 10,
          source: 'active-backtest',
          totalReturn: 3,
          maxDrawdown: 1,
          sharpe: 0.8,
          updatedAt: null,
          note: '参考',
        },
        optimizeTime: null,
      },
      strategy: {
        advice: {
          decisionTrace: {
            raw: {
              direction: 'long',
              composite: 2,
              confidence: 30,
              consensusPct: 100,
              summary: '原始偏多',
              topDrivers: [
                { category: 'momentum', label: '动量', score: 2, contribution: '上涨' },
              ],
            },
            technical: {
              verdict: 'confirm',
              agreementPct: 60,
              summary: '技术确认',
              checks: ['价格高于 MA20'],
            },
            impact: {
              verdict: 'supportive',
              summary: '影响因子支持',
              drivers: [],
            },
            backtest: {
              verdict: 'tradable',
              probability: 52.5,
              sampleTrades: 10,
              winRate: 55,
              totalReturn: 3,
              maxDrawdown: 1,
              sharpe: 0.8,
              summary: '回测可交易',
            },
            final: {
              action: '做多',
              originalDirection: 'long',
              finalDirection: 'long',
              directionOverridden: false,
              overrideReason: '',
              confidence: 30,
              summary: '做多',
              blockers: [],
            },
          },
        },
      },
    });
    assert.equal(value.direction, 'long');
    assert.equal(value.rawConfidence, 65);
    assert.equal(value.backtestCalibration?.profitProbability, 52.5);
    assert.equal(value.confidenceCalibration?.indicatorAgreement, 0.6);
    assert.equal(value.confidenceCalibration?.debug?.formula, 'raw + backtest');
    assert.equal(value.strategy?.advice.decisionTrace?.technical.agreementPct, 60);
    assert.equal(value.timeframeProfile?.role, 'trade');
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
      timeframeProfile: {
        tf: 'm5',
        label: '5m 主决策',
        role: 'trade',
        decisionWeight: 0.45,
        minSampleTrades: 20,
        params: { entryThreshold: 0.5, holdBars: 12 },
        calibration: {
          winRate: 40,
          profitProbability: 48,
          sampleTrades: 5,
          source: 'active-backtest',
          totalReturn: 1,
          maxDrawdown: 2,
          sharpe: 0.3,
          updatedAt: null,
          note: '参考',
        },
        optimizeTime: null,
      },
      activeProfiles: {},
    });
    assert.equal(value.metrics?.sharpeRatio, 0.3);
    assert.equal(value.timeframeProfile?.tf, 'm5');
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

  it('rejects non-finite backtest metrics', () => {
    assert.throws(() => parseBacktestResponse({
      metrics: {
        totalReturn: 1,
        winRate: 100,
        profitFactor: Number.POSITIVE_INFINITY,
        sharpe: 0.3,
        maxDrawdown: 0,
        totalTrades: 1,
        avgWin: 2,
        avgLoss: 0,
      },
      trades: [],
      equityCurve: [10000],
    }), /metrics.profitFactor/);
  });

  it('rejects malformed factor responses', () => {
    assert.throws(() => parseFactorsResponse({ factors: 'bad' }));
  });

  it('accepts data quality responses', () => {
    const value = parseQualityResponse({
      serverTime: 1000,
      overall: 'degraded',
      collectors: [
        {
          key: 'binance',
          state: 'open',
          transport: 'local',
          lastAttemptAt: 900,
          lastSuccessAt: 700,
          consecutiveFailures: 3,
          nextRetryAt: 30000,
          errorCode: 'Error',
          errorMessage: 'CIRCUIT_OPEN',
        },
      ],
      sources: [
        {
          key: 'naver',
          status: 'ok',
          ageSec: 10,
          expectedActive: true,
          detail: '₩250,000',
        },
      ],
    });
    assert.equal(value.collectors[0].state, 'open');
  });
});
