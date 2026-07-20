import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateOperationAdvice, AdviceContext, FactorDriver } from './advice';
import { Factor } from './factors';

function makeCtx(overrides: Partial<AdviceContext> = {}): AdviceContext {
  return {
    factors: [],
    composite: 0,
    direction: 'neutral',
    confidence: 0,
    currentPrice: 100,
    atrPct: 1.5,
    atrValue: 1.5,
    consensus: 0.5,
    regime: 'range',
    supportPrices: [95],
    resistancePrices: [105],
    ma20: 100,
    rsi: 50,
    fundingRate: 0,
    eventStatus: 'clear',
    basisZScore: 0,
    ...overrides,
  };
}

function factor(category: string, score: number): Factor {
  return { category, label: category, score, weight: 1, detail: '' };
}

describe('generateOperationAdvice', () => {
  it('returns "观望不动" when no factors available', () => {
    const advice = generateOperationAdvice(makeCtx());
    assert.equal(advice.action, '观望不动');
    assert.equal(advice.signalStrength, '无');
    assert.equal(advice.confidence, 0);
  });

  it('returns "观望不动" when currentPrice is 0', () => {
    const advice = generateOperationAdvice(makeCtx({ currentPrice: 0 }));
    assert.equal(advice.action, '观望不动');
  });

  describe('whale dominated pattern', () => {
    it('generates 做多 advice when whale score >= 3', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', 4), factor('momentum', 1)],
        direction: 'long',
        confidence: 60,
        currentPrice: 100,
        ma20: 98,
      }));
      assert.equal(advice.action, '做多');
      assert.ok(advice.reason.includes('大户'));
      assert.ok(advice.entry.price > 0);
    });

    it('generates 做空 advice when whale score <= -3', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', -4), factor('momentum', -1)],
        direction: 'short',
        confidence: 60,
        currentPrice: 100,
        ma20: 102,
      }));
      assert.equal(advice.action, '做空');
      assert.ok(advice.reason.includes('大户'));
    });
  });

  describe('premium dominated pattern', () => {
    it('generates 做空 advice when premium score >= 3', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('premium', 4)],
        direction: 'neutral',
        confidence: 50,
        currentPrice: 100,
      }));
      assert.equal(advice.action, '做空');
      assert.ok(advice.reason.includes('溢价'));
    });

    it('generates 做多 advice when premium score <= -3', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('premium', -4)],
        direction: 'neutral',
        confidence: 50,
        currentPrice: 100,
      }));
      assert.equal(advice.action, '做多');
      assert.ok(advice.reason.includes('折价'));
    });
  });

  describe('trend pattern (multi-factor resonance)', () => {
    it('generates 做多 advice when 3+ factors bullish and consensus high', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [
          factor('momentum', 3),
          factor('indicator', 2),
          factor('takerVol', 2),
          factor('openInterest', 2),
        ],
        direction: 'long',
        confidence: 70,
        consensus: 0.7,
        currentPrice: 100,
      }));
      assert.equal(advice.action, '做多');
      assert.ok(advice.reason.includes('趋势'));
    });
  });

  describe('reversal pattern (RSI extreme)', () => {
    it('generates 做多 advice when RSI < 30 and near support', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('indicator', 3)],
        direction: 'neutral',
        confidence: 40,
        rsi: 25,
        currentPrice: 96,
        supportPrices: [95],
      }));
      assert.equal(advice.action, '做多');
      assert.ok(advice.reason.includes('超卖'));
    });

    it('generates 做空 advice when RSI > 70 and near resistance', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('indicator', -3)],
        direction: 'neutral',
        confidence: 40,
        rsi: 75,
        currentPrice: 104,
        resistancePrices: [105],
      }));
      assert.equal(advice.action, '做空');
      assert.ok(advice.reason.includes('超买'));
    });
  });

  describe('contrarian lsRatio pattern', () => {
    it('generates 做多 advice when lsRatio extreme negative (散户看空)', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('lsRatio', 4)],
        direction: 'neutral',
        confidence: 40,
        currentPrice: 100,
      }));
      assert.equal(advice.action, '做多');
      assert.ok(advice.reason.includes('散户'));
    });
  });

  describe('exit advice', () => {
    it('provides TP and SL prices for long direction', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', 4)],
        direction: 'long',
        confidence: 70,
        currentPrice: 100,
        atrValue: 2,
      }));
      assert.ok(advice.exit.takeProfitPrice > 100);
      assert.ok(advice.exit.stopLossPrice < 100);
      assert.ok(advice.exit.riskReward.startsWith('1:'));
    });

    it('provides TP and SL prices for short direction', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', -4)],
        direction: 'short',
        confidence: 70,
        currentPrice: 100,
        atrValue: 2,
      }));
      assert.ok(advice.exit.takeProfitPrice < 100);
      assert.ok(advice.exit.stopLossPrice > 100);
    });

    it('returns dash for neutral direction', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('momentum', 0)],
        direction: 'neutral',
        confidence: 10,
        currentPrice: 100,
      }));
      assert.equal(advice.exit.takeProfit, '—');
      assert.equal(advice.exit.stopLoss, '—');
    });
  });

  describe('position advice', () => {
    it('returns 0% position for neutral direction', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('momentum', 0)],
        direction: 'neutral',
        confidence: 10,
        currentPrice: 100,
      }));
      assert.equal(advice.position.pct, 0);
      assert.equal(advice.position.leverage, '1x');
    });

    it('reduces position during freeze event', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', 4)],
        direction: 'long',
        confidence: 70,
        eventStatus: 'freeze',
        currentPrice: 100,
      }));
      assert.equal(advice.position.pct, 0);
    });

    it('reduces position when volatility high', () => {
      const lowVolAdvice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', 4)],
        direction: 'long',
        confidence: 70,
        atrPct: 0.5,
        currentPrice: 100,
      }));
      const highVolAdvice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', 4)],
        direction: 'long',
        confidence: 70,
        atrPct: 3.5,
        currentPrice: 100,
      }));
      assert.ok(highVolAdvice.position.pct < lowVolAdvice.position.pct);
    });
  });

  describe('warnings', () => {
    it('warns about high volatility', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', 4)],
        direction: 'long',
        confidence: 60,
        atrPct: 3.5,
        currentPrice: 100,
      }));
      assert.ok(advice.warnings.some(w => w.includes('波动')));
    });

    it('warns about freeze event', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', 4)],
        direction: 'long',
        confidence: 60,
        eventStatus: 'freeze',
        currentPrice: 100,
      }));
      assert.ok(advice.warnings.some(w => w.includes('财报')));
    });

    it('warns about extreme RSI', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('indicator', 2)],
        direction: 'long',
        confidence: 50,
        rsi: 78,
        currentPrice: 100,
      }));
      assert.ok(advice.warnings.some(w => w.includes('RSI')));
    });
  });

  describe('factor drivers', () => {
    it('returns top 5 factor drivers', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [
          factor('whale', 4),
          factor('momentum', 3),
          factor('premium', -2),
          factor('indicator', 1),
          factor('volume', 1),
          factor('funding', -1),
        ],
        direction: 'long',
        confidence: 60,
        currentPrice: 100,
      }));
      assert.ok(advice.drivers!.length <= 5);
      assert.ok(advice.drivers!.some(d => d.category === 'whale'));
    });

    it('includes contribution descriptions', () => {
      const advice = generateOperationAdvice(makeCtx({
        factors: [factor('whale', 4)],
        direction: 'long',
        confidence: 60,
        currentPrice: 100,
      }));
      const whaleDriver = advice.drivers!.find(d => d.category === 'whale');
      assert.ok(whaleDriver);
      assert.ok(whaleDriver.contribution.length > 0);
    });
  });
});
