import assert from 'node:assert/strict';
import test from 'node:test';
import { canRecordSpotTick } from './market-quality';

const atKst = (value: string) => Date.parse(`${value}+09:00`);

test('does not record spot ticks during fully closed sessions without OTC data', () => {
  assert.equal(canRecordSpotTick({
    nowMs: atKst('2026-07-13T19:00:00'),
    marketOpen: false,
    hasFreshAfterHours: false,
  }), false);
});

test('records spot ticks during regular and active after-hours sessions', () => {
  assert.equal(canRecordSpotTick({
    nowMs: atKst('2026-07-13T10:00:00'),
    marketOpen: true,
    hasFreshAfterHours: false,
  }), true);
  assert.equal(canRecordSpotTick({
    nowMs: atKst('2026-07-13T17:00:00'),
    marketOpen: false,
    hasFreshAfterHours: true,
  }), true);
});
