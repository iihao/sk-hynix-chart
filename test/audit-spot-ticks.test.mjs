import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidSpotSessionTimestamp } from '../scripts/audit-spot-ticks.mjs';

const atKst = (value) => Math.floor(Date.parse(`${value}+09:00`) / 1000);

test('classifies valid Korean session timestamps without mutating data', () => {
  assert.equal(isValidSpotSessionTimestamp(atKst('2026-07-13T09:00:00')), true);
  assert.equal(isValidSpotSessionTimestamp(atKst('2026-07-13T18:00:00')), true);
  assert.equal(isValidSpotSessionTimestamp(atKst('2026-07-13T19:00:00')), false);
  assert.equal(isValidSpotSessionTimestamp(atKst('2026-07-12T10:00:00')), false);
});
