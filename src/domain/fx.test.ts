import test from 'node:test';
import assert from 'node:assert/strict';
import { findFxAtOrBefore } from './fx';

test('aligns FX without selecting a future observation', () => {
  const ticks = [{ ts: 90, mid: 1400 }, { ts: 110, mid: 1500 }];
  assert.equal(findFxAtOrBefore(ticks, 100, 30)?.mid, 1400);
  assert.equal(findFxAtOrBefore([{ ts: 110, mid: 1500 }], 100, 30), undefined);
});

test('rejects an FX observation outside the tolerance', () => {
  assert.equal(findFxAtOrBefore([{ ts: 50, mid: 1400 }], 100, 30), undefined);
});
