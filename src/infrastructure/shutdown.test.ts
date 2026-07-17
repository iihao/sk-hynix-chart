import test from 'node:test';
import assert from 'node:assert/strict';
import { createShutdownCoordinator } from './shutdown';

test('runs shutdown steps once and exits after server closes', async () => {
  const calls: string[] = [];
  let closeCallback: ((error?: Error) => void) | null = null;
  const coordinator = createShutdownCoordinator({
    stopTimers: () => calls.push('timers'),
    stopCollectors: () => calls.push('collectors'),
    closeClients: () => calls.push('clients'),
    checkpoint: () => calls.push('checkpoint'),
    closeDatabase: () => calls.push('db'),
    closeServer: (done) => {
      calls.push('server');
      closeCallback = done;
    },
    exit: (code) => calls.push(`exit:${code}`),
    setTimeout: (() => 1) as any,
    clearTimeout: (() => {}) as any,
  });
  const first = coordinator.shutdown('SIGTERM');
  const second = coordinator.shutdown('SIGINT');
  closeCallback?.();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['timers', 'collectors', 'clients', 'checkpoint', 'server', 'db', 'exit:0']);
});

test('uses non-zero exit code when server close fails', async () => {
  const calls: string[] = [];
  const coordinator = createShutdownCoordinator({
    stopTimers: () => calls.push('timers'),
    closeServer: (done) => done(new Error('close failed')),
    exit: (code) => calls.push(`exit:${code}`),
    setTimeout: (() => 1) as any,
    clearTimeout: (() => {}) as any,
  });
  await coordinator.shutdown('manual');
  assert.deepEqual(calls, ['timers', 'exit:1']);
});
