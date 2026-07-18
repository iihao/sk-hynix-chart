import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBeijingCrosshairTime,
  formatBeijingOhlcTime,
  formatBeijingTickTime,
} from '../public/js/chart-time.mjs';

test('formats chart times in Beijing time across all chart labels', () => {
  const utcSeconds = Date.UTC(2026, 6, 18, 3, 1) / 1000;

  assert.equal(formatBeijingTickTime(utcSeconds), '11:01');
  assert.equal(formatBeijingOhlcTime(utcSeconds), '7/18 11:01');
  assert.equal(formatBeijingCrosshairTime(utcSeconds), "18 7月 '26 11:01");
});
