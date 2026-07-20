import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createInitialTimeframeStates,
  getTimeframeProfile,
  listTimeframeProfiles,
  normalizeProfileTimeframe,
  TimeframeKey,
} from './timeframe-profile';

describe('timeframe profiles', () => {
  it('normalizes UI and server timeframe aliases into one profile key set', () => {
    assert.equal(normalizeProfileTimeframe('1m'), 'm1');
    assert.equal(normalizeProfileTimeframe('5m'), 'm5');
    assert.equal(normalizeProfileTimeframe('15m'), 'm15');
    assert.equal(normalizeProfileTimeframe('1h'), 'h1');
    assert.equal(normalizeProfileTimeframe('bad'), 'm5');
  });

  it('keeps one shared profile shape across all supported timeframes', () => {
    const profiles = listTimeframeProfiles();
    assert.deepEqual(profiles.map((profile) => profile.tf), ['m1', 'm5', 'm15', 'h1']);
    for (const profile of profiles) {
      assert.ok(profile.defaultParams.entryThreshold >= 0.5);
      assert.ok(profile.thresholdCandidates.length >= 3);
      assert.ok(profile.holdBarsCandidates.length >= 3);
      assert.ok(profile.minSampleTrades > 0);
    }
  });

  it('uses 5m as the main decision profile and keeps 1m stricter for scalp noise', () => {
    const m1 = getTimeframeProfile('m1');
    const m5 = getTimeframeProfile('m5');

    assert.equal(m5.role, 'trade');
    assert.equal(m1.role, 'scalp');
    assert.ok(m1.defaultParams.entryThreshold >= m5.defaultParams.entryThreshold);
    assert.ok(m1.minSampleTrades >= m5.minSampleTrades);
  });

  it('creates independent optimized state per timeframe without changing the core weight keys', () => {
    const baseWeights = { momentum: 0.9, funding: 0.75, premium: 0.7, indicator: 0.6 };
    const states = createInitialTimeframeStates(baseWeights);

    states.m1.params.entryThreshold = 9;
    states.m1.weights.momentum = 0.1;

    const keys: TimeframeKey[] = ['m1', 'm5', 'm15', 'h1'];
    for (const tf of keys) {
      assert.deepEqual(Object.keys(states[tf].weights).sort(), Object.keys(baseWeights).sort());
    }
    assert.notEqual(states.m5.params.entryThreshold, 9);
    assert.notEqual(states.m5.weights.momentum, 0.1);
  });
});
