import assert from 'node:assert/strict';
import test from 'node:test';
import { createWahaClient } from '../../src/providers/waha/client.mjs';

test('the provider adapter normalizes its base URL and keeps credentials server-side', async () => {
  let request;
  const client = createWahaClient({
    baseUrl: 'http://provider:3000///',
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.deepEqual(await client.request('/api/sessions'), { ok: true });
  assert.equal(client.baseUrl, 'http://provider:3000');
  assert.equal(request.url, 'http://provider:3000/api/sessions');
  assert.equal(request.options.headers['x-api-key'], 'test-key');
});

test('the provider adapter only relays managed media paths', async () => {
  const client = createWahaClient({ baseUrl: 'http://provider:3000', fetchImpl: async () => new Response() });
  await assert.rejects(client.file('/not-managed'), { status: 400 });
});
