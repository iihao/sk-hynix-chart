import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backtestEngine } from './backtest';

function candle(time: number, close = 100, volume = 1) {
  return { time, open: close, high: close, low: close, close, volume };
}

describe('backtest accounting', () => {
  it('includes a forced close in final equity and return', () => {
    const candles = Array.from({ length: 52 }, (_, index) => candle(
      index,
      index === 50 ? 110 : index === 51 ? 120 : 100,
      index === 50 ? 2 : 1,
    ));
    const result = backtestEngine(candles, [], [], {
      threshold: 1.5,
      holdBars: 100,
      stopLossPct: 100,
      takeProfitPct: 100,
      leverage: 1,
    });

    assert.equal(result.trades.length, 1);
    assert.ok(result.metrics.totalReturn > 0);
    assert.equal(result.equityCurve[result.equityCurve.length - 1], 10909.09090909091);
    assert.equal(result.metrics.profitFactor, 999);
  });
});

describe('backtest observation alignment and weights', () => {
  const candles = Array.from({ length: 52 }, (_, index) => candle(index));
  const bullishBinance = [{ ts: 50, price: 100, funding_rate: -0.002 }];
  const bullishSentiment = [{
    ts: 50,
    ls_ratio: 0.4,
    taker_buy_vol: 300,
    taker_sell_vol: 100,
    open_interest: 1000,
  }];
  const params = {
    threshold: 1.2,
    holdBars: 100,
    stopLossPct: 100,
    takeProfitPct: 100,
    observationToleranceSec: 60,
  };

  it('uses observations timestamped at or before the candle', () => {
    const result = backtestEngine(candles, bullishBinance, bullishSentiment, params);
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].direction, 'long');
  });

  it('does not use future observations', () => {
    const futureBinance = bullishBinance.map((row) => ({ ...row, ts: 1000 }));
    const futureSentiment = bullishSentiment.map((row) => ({ ...row, ts: 1000 }));
    const result = backtestEngine(candles, futureBinance, futureSentiment, params);
    assert.equal(result.trades.length, 0);
  });

  it('allows aligned market factors to be disabled by weight', () => {
    const result = backtestEngine(candles, bullishBinance, bullishSentiment, {
      ...params,
      weights: { funding: 0, lsRatio: 0, takerVol: 0 },
    });
    assert.equal(result.trades.length, 0);
  });

  it('uses the aligned Binance price when FX is available', () => {
    const neutral = backtestEngine(candles, [{ ts: 50, price: 100 }], [], {
      ...params,
      threshold: 0.65,
      fxRate: 1,
    });
    const premium = backtestEngine(candles, [{ ts: 50, price: 103 }], [], {
      ...params,
      threshold: 0.65,
      fxRate: 1,
    });
    assert.equal(neutral.trades.length, 0);
    assert.equal(premium.trades.length, 1);
  });
});
