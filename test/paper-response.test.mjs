import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaperResponse } from '../public/js/paper-response.mjs';

test('reports a clear error when the paper API returns HTML instead of JSON', async () => {
  const response = new Response('<!DOCTYPE html><html><body>app shell</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

  await assert.rejects(
    () => parsePaperResponse(response, '/api/paper/account'),
    /模拟交易 API 返回了页面 HTML/,
  );
});

test('uses server supplied JSON error messages for failed paper API responses', async () => {
  const response = new Response(JSON.stringify({ error: { message: '余额不足' } }), {
    status: 400,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

  await assert.rejects(
    () => parsePaperResponse(response, '/api/paper/orders'),
    /余额不足/,
  );
});

test('parses successful paper API JSON responses', async () => {
  const payload = { account: { equity: 10000 }, positions: [] };
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

  assert.deepEqual(await parsePaperResponse(response, '/api/paper/account'), payload);
});
