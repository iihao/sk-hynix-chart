import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCompleteDashboardSnapshot, mergeBinanceIntoSnapshot } from './stream';

const snapshot = {
  m1: { candles: [{ time: 1, close: 100 }], meta: { price: 100 } },
  m5: { candles: [], meta: { price: 100 } },
  m15: { candles: [], meta: { price: 100 } },
  h1: { candles: [], meta: { price: 100 } },
  source: 'naver',
  krwUsd: 1400,
  serverTime: 1000,
  binance: null,
};

describe('complete dashboard stream snapshots', () => {
  it('merges Binance data without replacing spot state', () => {
    const binance = { m5: { line: [{ time: 1, value: 101 }] } };
    const result = mergeBinanceIntoSnapshot(snapshot, binance, 2000);

    assert.equal(result.m1, snapshot.m1);
    assert.equal(result.m5, snapshot.m5);
    assert.equal(result.m15, snapshot.m15);
    assert.equal(result.h1, snapshot.h1);
    assert.equal(result.source, 'naver');
    assert.equal(result.krwUsd, 1400);
    assert.equal(result.serverTime, 2000);
    assert.equal(result.binance, binance);
  });

  it('rejects a partial spot snapshot', () => {
    assert.equal(isCompleteDashboardSnapshot({ binance: {} }), false);
    assert.throws(
      () => mergeBinanceIntoSnapshot({ binance: {} }, {}, 2000),
      /INCOMPLETE_DASHBOARD_SNAPSHOT/,
    );
  });
});
