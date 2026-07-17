import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinanceTransport } from './binance-transport';

test('uses direct transport when no proxy is configured', async () => {
  const transport = createBinanceTransport({directRequest: async () => 'direct'});
  assert.deepEqual(await transport.request('/x'), {data: 'direct', transport: 'direct'});
});

test('falls back from configured proxy to direct', async () => {
  const calls: string[] = [];
  const transport = createBinanceTransport({
    proxyUrl: 'http://proxy',
    proxyRequest: async () => { calls.push('proxy'); throw new Error('proxy down'); },
    directRequest: async () => { calls.push('direct'); return 'ok'; },
  });
  assert.deepEqual(await transport.request('/x'), {data: 'ok', transport: 'direct'});
  assert.deepEqual(calls, ['proxy', 'direct']);
});
