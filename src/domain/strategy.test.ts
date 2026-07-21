import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Factor } from './factors';
import { generateStrategy } from './strategy';

function strategyFixture(overrides: Partial<Parameters<typeof generateStrategy>[0]> = {}) {
  const factors: Factor[] = [
    { category: 'momentum', label: '动量', score: 2, weight: 1, detail: '偏多' },
    { category: 'funding', label: '费率', score: 1, weight: 1, detail: '偏多' },
  ];

  return generateStrategy({
    factors,
    composite: 0.4,
    indicators: {
      rsi: 50,
      macd: { dif: 0, dea: 0, histogram: 0 },
      ma5: 100,
      ma20: 100,
      bollinger: { upper: 110, mid: 100, lower: 90 },
      volRatio: 1,
    } as any,
    candles: Array.from({ length: 30 }, () => ({ close: 100, high: 101, low: 99 })),
    support: [{ price: 95, type: 'support', strength: 1 }],
    resistance: [{ price: 105, type: 'resistance', strength: 1 }],
    naverPrice: 100,
    binancePrice: 100,
    fundingRate: 0,
    eventStatus: 'clear',
    basisZScore: 0,
    atrPct: 1,
    ...overrides,
  });
}

describe('generateStrategy', () => {
  it('uses the calibrated entry threshold when deciding whether a signal is tradable', () => {
    const conservative = strategyFixture({ entryThreshold: 0.5 });
    const permissive = strategyFixture({ entryThreshold: 0.2 });

    assert.equal(conservative.direction, 'neutral');
    assert.equal(permissive.direction, 'long');
  });

  it('uses calibrated confidence for strategy and operation advice strength', () => {
    const result = strategyFixture({ entryThreshold: 0.2, calibratedConfidence: 38 });

    assert.equal(result.confidence, 38);
    assert.equal(result.advice.confidence, 38);
  });

  it('passes backtest and calibration context into the operation decision trace', () => {
    const result = strategyFixture({
      entryThreshold: 0.2,
      calibratedConfidence: 62,
      backtestCalibration: {
        winRate: 53,
        profitProbability: 52,
        sampleTrades: 22,
        source: 'active-backtest',
        totalReturn: 5,
        maxDrawdown: 6,
        sharpe: 0.8,
        updatedAt: null,
        note: 'active',
      },
      confidenceCalibration: {
        rawConfidence: 70,
        confidence: 62,
        backtestProbability: 52,
        sampleTrades: 22,
        factorAgreement: 0.7,
        indicatorAgreement: 0.6,
        penalties: [],
        note: 'ok',
      },
    });

    assert.equal(result.advice.decisionTrace.backtest.sampleTrades, 22);
    assert.equal(result.advice.decisionTrace.technical.agreementPct, 60);
  });
});
