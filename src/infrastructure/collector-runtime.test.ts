import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectorRuntime } from './collector-runtime';

test('prevents overlapping collector runs and records success', async () => {
  let resolve!: () => void;
  const runtime = createCollectorRuntime({key: 'binance', now: () => 100});
  const first = runtime.run(() => new Promise<void>((done) => { resolve = done; }), 'direct');
  assert.deepEqual(await runtime.run(async () => {}, 'direct'), {skipped: true});
  resolve();
  await first;
  assert.equal(runtime.snapshot().state, 'healthy');
  assert.equal(runtime.snapshot().lastSuccessAt, 100);
});
