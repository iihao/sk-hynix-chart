import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from './scheduler';

test('tracks and clears registered timers', () => {
  const cleared: number[] = [];
  let next = 1;
  const scheduler = createScheduler({
    setTimeout: (() => next++) as any,
    clearTimeout: ((handle: number) => { cleared.push(handle); }) as any,
    setInterval: (() => next++) as any,
    clearInterval: ((handle: number) => { cleared.push(handle); }) as any,
  });
  scheduler.setTimeout(() => {}, 100);
  scheduler.setInterval(() => {}, 200);
  assert.deepEqual(scheduler.snapshot(), {timeouts: 1, intervals: 1});
  scheduler.stopAll();
  assert.deepEqual(cleared, [1, 2]);
  assert.deepEqual(scheduler.snapshot(), {timeouts: 0, intervals: 0});
});

test('removes one-shot timers after they fire', () => {
  let callback: (() => void) | null = null;
  const scheduler = createScheduler({
    setTimeout: (((fn: () => void) => { callback = fn; return 1; }) as any),
    clearTimeout: (() => {}) as any,
  });
  scheduler.setTimeout(() => {}, 100);
  assert.equal(scheduler.snapshot().timeouts, 1);
  callback?.();
  assert.equal(scheduler.snapshot().timeouts, 0);
});
