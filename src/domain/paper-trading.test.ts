import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  closePaperPosition,
  findTriggeredExit,
  markPaperPosition,
  openPaperPosition,
  PaperTradeValidationError,
} from './paper-trading';

const account = {
  initialBalance: 10_000,
  availableBalance: 10_000,
  realizedPnl: 0,
};

describe('paper trading accounting', () => {
  it('opens a long position by reserving margin and taker fee', () => {
    const result = openPaperPosition(account, {
      direction: 'long',
      entryPrice: 100,
      notional: 1_000,
      leverage: 10,
      takeProfitPrice: 110,
      stopLossPrice: 95,
      now: 1000,
    });

    assert.equal(result.position.quantity, 10);
    assert.equal(result.position.margin, 100);
    assert.equal(result.account.availableBalance, 9899.5);
    assert.equal(result.account.realizedPnl, -0.5);
    assert.equal(result.fill.type, 'OPEN');
  });

  it('rejects orders that exceed available balance', () => {
    assert.throws(
      () => openPaperPosition({ ...account, availableBalance: 50 }, {
        direction: 'long',
        entryPrice: 100,
        notional: 1_000,
        leverage: 10,
        now: 1000,
      }),
      PaperTradeValidationError,
    );
  });

  it('marks long and short positions to market', () => {
    const long = openPaperPosition(account, {
      direction: 'long', entryPrice: 100, notional: 1_000, leverage: 10, now: 1000,
    }).position;
    const short = { ...long, direction: 'short' as const };

    assert.equal(markPaperPosition(long, 105).unrealizedPnl, 50);
    assert.equal(markPaperPosition(short, 95).unrealizedPnl, 50);
  });

  it('closes a position and releases margin with realized PnL', () => {
    const opened = openPaperPosition(account, {
      direction: 'long', entryPrice: 100, notional: 1_000, leverage: 10, now: 1000,
    });
    const closed = closePaperPosition(opened.account, opened.position, {
      exitPrice: 110,
      now: 1100,
      type: 'CLOSE',
    });

    assert.equal(closed.fill.realizedPnl, 99.45);
    assert.equal(closed.account.availableBalance, 10098.95);
    assert.equal(closed.account.realizedPnl, 98.95);
  });

  it('detects take-profit and stop-loss triggers', () => {
    const long = openPaperPosition(account, {
      direction: 'long',
      entryPrice: 100,
      notional: 1_000,
      leverage: 10,
      takeProfitPrice: 110,
      stopLossPrice: 95,
      now: 1000,
    }).position;
    const short = {
      ...long,
      direction: 'short' as const,
      takeProfitPrice: 90,
      stopLossPrice: 105,
    };

    assert.deepEqual(findTriggeredExit(long, 110), { type: 'TAKE_PROFIT', price: 110 });
    assert.deepEqual(findTriggeredExit(long, 94), { type: 'STOP_LOSS', price: 95 });
    assert.deepEqual(findTriggeredExit(short, 90), { type: 'TAKE_PROFIT', price: 90 });
    assert.deepEqual(findTriggeredExit(short, 106), { type: 'STOP_LOSS', price: 105 });
  });
});
