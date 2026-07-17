import test from 'node:test';
import assert from 'node:assert/strict';
import { canRecordSpotTick, classifyObservationAge, getKoreaSession } from './market-quality';

function atKst(isoWithoutZone: string): number {
  return Date.parse(`${isoWithoutZone}+09:00`);
}

test('records only quotes valid for an active Korean trading session', () => {
  assert.equal(getKoreaSession(atKst('2026-07-13T09:00:00')), 'regular');
  assert.equal(getKoreaSession(atKst('2026-07-13T17:00:00')), 'after');
  assert.equal(getKoreaSession(atKst('2026-07-13T19:00:00')), 'closed');
  assert.equal(getKoreaSession(atKst('2026-07-12T10:00:00')), 'closed');

  assert.equal(canRecordSpotTick({
    nowMs: atKst('2026-07-13T19:00:00'), marketOpen: false, hasFreshAfterHours: false,
  }), false);
  assert.equal(canRecordSpotTick({
    nowMs: atKst('2026-07-13T17:00:00'), marketOpen: false, hasFreshAfterHours: true,
  }), true);
  assert.equal(canRecordSpotTick({
    nowMs: atKst('2026-07-13T17:00:00'), marketOpen: false, hasFreshAfterHours: false,
  }), false);
});

test('classifies an observation using its real exchange timestamp', () => {
  assert.deepEqual(classifyObservationAge({ nowSec: 1000, exchangeTs: 900, maxAgeSec: 120 }), {
    eligible: true, ageSec: 100, quality: 'live',
  });
  assert.deepEqual(classifyObservationAge({ nowSec: 1000, exchangeTs: 850, maxAgeSec: 120 }), {
    eligible: false, ageSec: 150, quality: 'stale',
  });
});
