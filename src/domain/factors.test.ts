import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateAllFactors, calculateWeightedComposite, Factor } from './factors';

describe('calculateWeightedComposite', () => {
  const factors: Factor[] = [
    { category: 'momentum', label: 'Momentum', score: 4, weight: 1, detail: '' },
    { category: 'funding', label: 'Funding', score: -2, weight: 1, detail: '' },
  ];

  it('uses factor weights by default', () => {
    assert.equal(calculateWeightedComposite(factors).composite, 1);
  });

  it('allows a factor weight to be disabled', () => {
    assert.equal(calculateWeightedComposite(factors, { funding: 0 }).composite, 4);
  });
});

describe('calculateAllFactors optional market inputs', () => {
  it('includes each available sentiment factor exactly once', () => {
    const candles = Array.from({ length: 30 }, (_, index) => ({
      close: 100 + index,
      high: 101 + index,
      low: 99 + index,
      volume: 100 + index,
    }));
    const result = calculateAllFactors({
      candles,
      fundingRate: 0,
      krwUsd: 1400,
      prevKrwUsd: 1400,
      naverPrice: 140000,
      binancePrice: 100,
      fxRate: 1400,
      rsi: 50,
      macdHist: 0,
      support: [],
      resistance: [],
      longRatio: 0.5,
      buyVol: 200,
      sellVol: 100,
      oiChange: 2,
      priceChange: 1,
    });

    for (const category of ['lsRatio', 'takerVol', 'openInterest']) {
      assert.equal(result.factors.filter((factor) => factor.category === category).length, 1);
    }
  });

  it('omits factors when data is missing', () => {
    const candles = Array.from({ length: 30 }, (_, index) => ({
      close: 100 + index, high: 101 + index, low: 99 + index, volume: 0,
    }));
    const result = calculateAllFactors({
      candles,
      fundingRate: 0,
      krwUsd: 1400,
      prevKrwUsd: 1390,
      naverPrice: 140000,
      binancePrice: 0,
      fxRate: 1400,
      rsi: 50,
      macdHist: 0,
      support: [],
      resistance: [],
    });

    // Premium should have score 0 when binancePrice is 0
    const premiumFactor = result.factors.find(f => f.category === 'premium');
    assert.equal(premiumFactor?.score, 0);
  });
});
