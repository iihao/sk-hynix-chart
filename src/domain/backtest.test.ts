import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { annualizationBars, backtestEngine } from './backtest';

function candle(time: number, close = 100, volume = 1) {
  return { time, open: close, high: close, low: close, close, volume };
}

describe('backtest accounting', () => {
  it('includes a forced close in final equity and return', () => {
    const candles = Array.from({ length: 53 }, (_, index) => candle(
      index,
      index === 50 ? 110 : index === 51 ? 110 : index === 52 ? 120 : 100,
      index === 50 ? 2 : 1,
    ));
    const result = backtestEngine(candles, [], [], {
      threshold: 1.5,
      holdBars: 100,
      stopLossPct: 100,
      takeProfitPct: 100,
      leverage: 1,
      feeRate: 0,
      slippageBps: 0,
    });

    assert.equal(result.trades.length, 1);
    assert.ok(result.metrics.totalReturn > 0);
    assert.ok(Math.abs(result.equityCurve[result.equityCurve.length - 1] - 10909.09090909091) < 1e-9);
    assert.equal(result.metrics.profitFactor, 999);
  });

  it('fills on the next open and uses the conservative stop when stop and target both trade', () => {
    const candles = Array.from({ length: 53 }, (_, index) => candle(index));
    candles[51] = { time: 51, open: 101, high: 101, low: 101, close: 101, volume: 0 };
    candles[52] = { time: 52, open: 101, high: 110, low: 90, close: 105, volume: 0 };
    const result = backtestEngine(candles, [{ ts: 50, price: 100, funding_rate: -0.002 }], [], {
      threshold: 0.8,
      holdBars: 100,
      stopLossPct: 5,
      takeProfitPct: 5,
      feeRate: 0,
      slippageBps: 0,
    });
    assert.equal(result.trades[0].entry, 101);
    assert.equal(result.trades[0].exitReason, 'stopLoss');
    assert.equal(result.trades[0].exit, 95.95);
  });

  it('deducts fees, slippage, and explicit funding events', () => {
    const candles = Array.from({ length: 53 }, (_, index) => candle(index));
    candles[51] = { time: 51, open: 100, high: 100, low: 100, close: 100, volume: 0 };
    candles[52] = { time: 52, open: 100, high: 102, low: 100, close: 102, volume: 0 };
    const result = backtestEngine(candles, [
      { ts: 50, price: 100, funding_rate: -0.002 },
      { ts: 52, price: 102, funding_rate: 0.001, isFundingEvent: true },
    ], [], {
      threshold: 0.8,
      holdBars: 1,
      stopLossPct: 50,
      takeProfitPct: 50,
      leverage: 2,
      feeRate: 0.0005,
      slippageBps: 10,
    });
    assert.ok(result.costs.fees > 0);
    assert.ok(result.costs.slippage > 0);
    assert.ok(result.costs.funding > 0);
    assert.ok(result.metrics.totalReturn < 4);
  });

  it('annualizes metrics according to the selected timeframe', () => {
    assert.ok(annualizationBars('m1') > annualizationBars('h1'));
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
