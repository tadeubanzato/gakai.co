import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-instagram-image-refresh-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

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
  body: JSON.stringify({ username: 'instagram-image-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('a stale cached og:image link is retried with a fresh scrape instead of just failing', async () => {
  const pageUrl = 'https://www.instagram.com/reel/stale-fixture/';
  const staleImageUrl = 'https://scontent.cdninstagram.com/stale-signed-image.jpg';
  const freshImageUrl = 'https://scontent.cdninstagram.com/fresh-signed-image.jpg';
  let htmlFetchCount = 0;

  // The og:title/description stay identical across both scrapes — only the
  // signed image link "expires" and gets replaced, mirroring what actually
  // happens on Instagram's side.
  // instagramPreview()/fetchImage() call fetch() with a URL instance (from
  // safeInstagramPage/safeInstagramImage), not a string — read .href either way.
  const hrefOf = input => typeof input === 'string' ? input : input.href;
  globalThis.fetch = async input => {
    const href = hrefOf(input);
    if (href.startsWith(pageUrl)) {
      htmlFetchCount += 1;
      const imageUrl = htmlFetchCount === 1 ? staleImageUrl : freshImageUrl;
      const html = `<html><head><meta property="og:title" content="Stale Fixture"><meta property="og:image" content="${imageUrl}"></head></html>`;
      return new Response(html, { status: 200 });
    }
    if (href === staleImageUrl) return new Response('', { status: 403 }); // expired signed token
    if (href === freshImageUrl) return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    throw new Error('unexpected fetch in test: ' + href);
  };

  let response, body;
  try {
    response = await realFetch(`${base}/api/app/instagram-image?url=${encodeURIComponent(pageUrl)}`, { headers: { cookie } });
    body = Buffer.from(await response.arrayBuffer());
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(body, pngBytes);
  assert.equal(htmlFetchCount, 2, 'a failed image fetch must trigger exactly one forced re-scrape, not zero and not a retry loop');
});

test('instagram-image returns 502 when both the cached and freshly re-scraped image links fail', async () => {
  const pageUrl = 'https://www.instagram.com/reel/always-broken-fixture/';
  const deadImageUrl = 'https://scontent.cdninstagram.com/dead-image.jpg';

  const hrefOf = input => typeof input === 'string' ? input : input.href;
  globalThis.fetch = async input => {
    const href = hrefOf(input);
    if (href.startsWith(pageUrl)) {
      const html = `<html><head><meta property="og:title" content="Always Broken"><meta property="og:image" content="${deadImageUrl}"></head></html>`;
      return new Response(html, { status: 200 });
    }
    if (href === deadImageUrl) return new Response('', { status: 403 });
    throw new Error('unexpected fetch in test: ' + href);
  };

  let response;
  try {
    response = await realFetch(`${base}/api/app/instagram-image?url=${encodeURIComponent(pageUrl)}`, { headers: { cookie } });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(response.status, 502);
});

test('instagram-image rejects a non-Instagram page URL', async () => {
  const response = await realFetch(`${base}/api/app/instagram-image?url=${encodeURIComponent('https://example.com/not-instagram')}`, { headers: { cookie } });
  assert.equal(response.status, 400);
});

test('instagram-image rejects a raw CDN image URL passed where the page URL belongs', async () => {
  // A stale client (old cached bundle, or any other caller) might still send
  // the raw signed cdninstagram.com image link this endpoint used to accept
  // directly. "cdninstagram.com" ends with the substring "instagram.com", so
  // a naive suffix check would wrongly accept it as a page URL and try to
  // fetch it as HTML — assert that doesn't happen.
  const response = await realFetch(`${base}/api/app/instagram-image?url=${encodeURIComponent('https://scontent-sea1-1.cdninstagram.com/some-image.jpg')}`, { headers: { cookie } });
  assert.equal(response.status, 400);
});
