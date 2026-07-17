import test from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker } from './circuit-breaker';

test('opens after three failures and suppresses calls until half-open', async () => {
  let now = 0;
  let calls = 0;
  const breaker = createCircuitBreaker({now: () => now, failureThreshold: 3, initialCooldownMs: 30000, maxCooldownMs: 300000});
  const fail = async () => { calls++; throw new Error('network'); };
  for (let i = 0; i < 3; i++) await assert.rejects(breaker.execute(fail));
  assert.equal(breaker.snapshot().state, 'open');
  await assert.rejects(breaker.execute(fail), /CIRCUIT_OPEN/);
  assert.equal(calls, 3);
  now = 30000;
  await breaker.execute(async () => 'ok');
  assert.equal(breaker.snapshot().state, 'closed');
});

test('shares one half-open probe and increases cooldown after probe failure', async () => {
  let now = 0;
  let resolveProbe!: (value: string) => void;
  const breaker = createCircuitBreaker({now: () => now, failureThreshold: 1, initialCooldownMs: 30000, maxCooldownMs: 300000});
  await assert.rejects(breaker.execute(async () => { throw new Error('network'); }));
  now = 30000;
  let calls = 0;
  const probe = () => { calls++; return new Promise<string>((resolve) => { resolveProbe = resolve; }); };
  const first = breaker.execute(probe);
  const second = breaker.execute(probe);
  resolveProbe('ok');
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
  assert.equal(calls, 1);

  await assert.rejects(breaker.execute(async () => { throw new Error('again'); }));
  assert.equal(breaker.snapshot().cooldownMs, 30000);
  now += 30000;
  await assert.rejects(breaker.execute(async () => { throw new Error('probe'); }));
  assert.equal(breaker.snapshot().cooldownMs, 60000);
});
