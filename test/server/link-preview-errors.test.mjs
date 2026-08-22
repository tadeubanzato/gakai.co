import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-link-preview-errors-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_INSTAGRAM_PREVIEW_RETRY_MS = '20';

const { server } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
// Captured before any override, so calls made through this reference always
// hit the real network stack regardless of what globalThis.fetch is doing.
const realFetch = globalThis.fetch;

const setup = await realFetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'preview-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('a failed Instagram preview fetch is logged but still returns a graceful empty preview', async () => {
  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => { errorCalls.push(args); };
  // instagramPreview calls the global `fetch` directly (not injectable), so
  // this is the only way to force its network call to fail deterministically
  // without depending on real instagram.com behavior.
  globalThis.fetch = async () => { throw new Error('simulated network failure'); };

  let response, body;
  try {
    response = await realFetch(`${base}/api/app/instagram-preview?url=${encodeURIComponent('https://www.instagram.com/p/fixture-post/')}`, { headers: { cookie } });
    body = await response.json();
  } finally {
    globalThis.fetch = realFetch;
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 200, 'a fetch failure must not surface as an error response to the client');
  assert.deepEqual(body, { title: null, description: null, image: null });
  assert.ok(errorCalls.some(args => String(args[0] || '').includes('Instagram preview fetch failed')), 'the failure must be logged, unlike before this fix');
});

test('a failed fetch is retried after GAKAI_INSTAGRAM_PREVIEW_RETRY_MS, instead of caching the failure forever', async () => {
  const postUrl = 'https://www.instagram.com/p/retry-fixture-post/';
  const fakeHtml = '<html><head><meta property="og:title" content="Real Post Title"><meta property="og:image" content="https://scontent.cdninstagram.com/real-image.jpg"></head></html>';

  // First attempt fails.
  globalThis.fetch = async () => { throw new Error('simulated transient failure'); };
  const first = await realFetch(`${base}/api/app/instagram-preview?url=${encodeURIComponent(postUrl)}`, { headers: { cookie } });
  const firstBody = await first.json();
  assert.deepEqual(firstBody, { title: null, description: null, image: null });

  // Immediately after: still within the retry window, so the cached failure
  // must still be returned even though fetch would now succeed — proves this
  // isn't just "never cache failures" but a real short-lived cache.
  globalThis.fetch = async () => new Response(fakeHtml, { status: 200 });
  const immediate = await realFetch(`${base}/api/app/instagram-preview?url=${encodeURIComponent(postUrl)}`, { headers: { cookie } });
  const immediateBody = await immediate.json();
  assert.deepEqual(immediateBody, { title: null, description: null, image: null }, 'still within the retry TTL, must still return the cached failure');

  // Past the (20ms, test-configured) retry window: the next call must
  // actually retry and this time succeed.
  await new Promise(resolve => setTimeout(resolve, 40));
  const retried = await realFetch(`${base}/api/app/instagram-preview?url=${encodeURIComponent(postUrl)}`, { headers: { cookie } });
  const retriedBody = await retried.json();
  globalThis.fetch = realFetch;

  assert.equal(retriedBody.title, 'Real Post Title', 'past the retry window, a fresh fetch must actually happen and succeed');
});
