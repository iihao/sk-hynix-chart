import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBacktestCalibration, calibrateSignalConfidence } from './calibration';
import { Factor } from './factors';

const bullishFactors: Factor[] = [
  { category: 'momentum', label: '动量', score: 4, weight: 1, detail: '强' },
  { category: 'premium', label: '溢价', score: 3, weight: 0.7, detail: '强' },
  { category: 'funding', label: '费率', score: 1, weight: 0.8, detail: '偏多' },
];

const bullishIndicators = {
  rsi: 58,
  macd: { dif: 1, dea: 0.5, histogram: 0.7 },
  bollinger: { upper: 120, mid: 100, lower: 80 },
  ma5: 106,
  ma20: 100,
  volRatio: 1.3,
};

describe('buildBacktestCalibration', () => {
  it('uses a neutral probability when no backtest sample is available', () => {
    const result = buildBacktestCalibration(null);

    assert.equal(result.source, 'insufficient');
    assert.equal(result.sampleTrades, 0);
    assert.equal(result.profitProbability, 50);
  });

  it('shrinks tiny high-win samples toward neutral instead of exposing raw win rate', () => {
    const result = buildBacktestCalibration({
      totalTrades: 2,
      winRate: 100,
      avgWin: 2,
      avgLoss: 0,
      totalReturn: 4,
      maxDrawdown: 1,
      sharpe: 1.2,
      profitFactor: 999,
      avgHoldBars: 3,
      expectancy: 20,
    });

    assert.equal(result.winRate, 100);
    assert.equal(result.source, 'insufficient');
    assert.ok(result.profitProbability < 60);
  });

  it('marks sufficiently sampled backtests as active calibration', () => {
    const result = buildBacktestCalibration({
      totalTrades: 20,
      winRate: 65,
      avgWin: 2,
      avgLoss: -1,
      totalReturn: 8,
      maxDrawdown: 3,
      sharpe: 1.4,
      profitFactor: 1.8,
      avgHoldBars: 6,
      expectancy: 15,
    }, '2026-07-20T00:00:00.000Z');

    assert.equal(result.source, 'active-backtest');
    assert.equal(result.profitProbability, 57.5);
    assert.equal(result.updatedAt, '2026-07-20T00:00:00.000Z');
  });
});

describe('calibrateSignalConfidence', () => {
  it('keeps tiny-sample confidence conservative even when raw factor strength is high', () => {
    const result = calibrateSignalConfidence({
      rawConfidence: 82,
      composite: 1.4,
      direction: 'long',
      factors: bullishFactors,
      indicators: bullishIndicators,
      currentPrice: 108,
      backtestCalibration: buildBacktestCalibration({
        totalTrades: 2,
        winRate: 100,
        avgWin: 2,
        avgLoss: 0,
        totalReturn: 5,
        maxDrawdown: 1,
        sharpe: 1.5,
        profitFactor: 999,
        avgHoldBars: 3,
        expectancy: 20,
      }),
    });

    assert.equal(result.rawConfidence, 82);
    assert.ok(result.confidence < 65);
    assert.ok(result.penalties.includes('sample'));
  });

  it('penalizes confidence when backtest return is negative or drawdown is large', () => {
    const result = calibrateSignalConfidence({
      rawConfidence: 80,
      composite: 1.3,
      direction: 'long',
      factors: bullishFactors,
      indicators: bullishIndicators,
      currentPrice: 108,
      backtestCalibration: buildBacktestCalibration({
        totalTrades: 30,
        winRate: 60,
        avgWin: 1,
        avgLoss: -2,
        totalReturn: -6,
        maxDrawdown: 18,
        sharpe: -0.2,
        profitFactor: 0.7,
        avgHoldBars: 6,
        expectancy: -30,
      }),
    });

    assert.ok(result.confidence < 50);
    assert.ok(result.penalties.includes('performance'));
    assert.ok(result.penalties.includes('drawdown'));
  });

  it('rewards confidence only when indicators and factors agree with a sufficiently tested backtest', () => {
    const result = calibrateSignalConfidence({
      rawConfidence: 72,
      composite: 1.2,
      direction: 'long',
      factors: bullishFactors,
      indicators: bullishIndicators,
      currentPrice: 108,
      backtestCalibration: buildBacktestCalibration({
        totalTrades: 40,
        winRate: 68,
        avgWin: 2.2,
        avgLoss: -1,
        totalReturn: 14,
        maxDrawdown: 4,
        sharpe: 1.6,
        profitFactor: 2.1,
        avgHoldBars: 8,
        expectancy: 35,
      }),
    });

    assert.ok(result.confidence > 70);
    assert.ok(result.indicatorAgreement > 0.6);
    assert.ok(result.factorAgreement > 0.6);
    assert.equal(result.penalties.length, 0);
  });

  it('does not reward technical indicators that diverge from the factor direction', () => {
    const result = calibrateSignalConfidence({
      rawConfidence: 72,
      composite: 1.2,
      direction: 'long',
      factors: bullishFactors,
      indicators: {
        ...bullishIndicators,
        rsi: 74,
        macd: { dif: -1, dea: -0.5, histogram: -0.8 },
        ma5: 96,
        ma20: 100,
      },
      currentPrice: 94,
      backtestCalibration: buildBacktestCalibration({
        totalTrades: 40,
        winRate: 68,
        avgWin: 2.2,
        avgLoss: -1,
        totalReturn: 14,
        maxDrawdown: 4,
        sharpe: 1.6,
        profitFactor: 2.1,
        avgHoldBars: 8,
        expectancy: 35,
      }),
    });

    assert.ok(result.confidence < 65);
    assert.ok(result.indicatorAgreement < 0.4);
    assert.ok(result.penalties.includes('indicator_divergence'));
  });
});
