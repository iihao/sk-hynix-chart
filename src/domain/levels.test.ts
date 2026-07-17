import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLevelGroups } from './levels';

test('keeps spot and futures levels in separate currencies', () => {
  const groups = buildLevelGroups({
    spot: { support: [{ price: 1800000, strength: 2 }], resistance: [] },
    futures: { support: [{ price: 1186, strength: 1 }], resistance: [] },
  });
  assert.equal(groups.spot.currency, 'KRW');
  assert.equal(groups.futures.currency, 'USDT');
  assert.equal(groups.spot.support[0].price, 1800000);
  assert.equal(groups.futures.support[0].price, 1186);
});
