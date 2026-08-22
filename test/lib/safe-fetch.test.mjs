import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { fetchPinned, validatePublicUrl } from '../../src/lib/safe-fetch.mjs';

test('validatePublicUrl rejects private, loopback, link-local, and .local/localhost targets', async () => {
  const lookupPrivate = async () => [{ address: '10.0.0.5' }];
  const lookupPublic = async () => [{ address: '93.184.216.34' }];

  assert.equal(await validatePublicUrl('https://internal.example/', { lookupImpl: lookupPrivate }), null);
  assert.equal(await validatePublicUrl('https://localhost/', { lookupImpl: lookupPublic }), null);
  assert.equal(await validatePublicUrl('https://box.local/', { lookupImpl: lookupPublic }), null);
  assert.equal(await validatePublicUrl('ftp://example.com/', { lookupImpl: lookupPublic }), null);
  assert.equal(await validatePublicUrl('not a url at all', { lookupImpl: lookupPublic }), null);
});

test('validatePublicUrl accepts a hostname that resolves to a public address', async () => {
  const lookupImpl = async () => [{ address: '93.184.216.34' }];
  const result = await validatePublicUrl('https://example.com/path', { lookupImpl });
  assert.ok(result);
  assert.equal(result.address, '93.184.216.34');
  assert.equal(result.url.href, 'https://example.com/path');
});

test('validatePublicUrl rejects a hostname where any resolved address is private (multi-A-record rebinding)', async () => {
  const lookupImpl = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }];
  assert.equal(await validatePublicUrl('https://mixed.example/', { lookupImpl }), null);
});

test('validatePublicUrl requireHttps rejects http even for a public address (n8n webhook rigor)', async () => {
  const lookupImpl = async () => [{ address: '93.184.216.34' }];
  assert.equal(await validatePublicUrl('http://example.com/webhook', { requireHttps: true, lookupImpl }), null);
  assert.ok(await validatePublicUrl('https://example.com/webhook', { requireHttps: true, lookupImpl }));
});

test('fetchPinned connects to the single validated address and never re-resolves DNS for the connection itself', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('pinned-response'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  let lookupCalls = 0;
  const lookupImpl = async () => { lookupCalls += 1; return [{ address: '127.0.0.1' }]; };
  // The real privateAddress() check would (correctly) reject the loopback
  // address our own test server binds to; disable it here since this test is
  // about connection-pinning behavior, not the private-address rejection
  // logic (already covered above).
  const isPrivate = () => false;

  try {
    const response = await fetchPinned(`http://rebind-test.invalid:${port}/`, { lookupImpl, isPrivate });
    const body = await response.text();

    assert.equal(response.ok, true);
    assert.equal(body, 'pinned-response');
    assert.equal(lookupCalls, 1, 'the connection must reuse the single validated resolution, never re-resolve');
  } finally {
    server.close();
  }
});

test('fetchPinned rejects a target that fails validation before ever connecting', async () => {
  const lookupImpl = async () => [{ address: '10.0.0.1' }];
  await assert.rejects(fetchPinned('https://internal.example/', { lookupImpl }), error => error.status === 400);
});

test('fetchPinned re-validates and re-pins each redirect hop independently', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === '/start') { res.writeHead(302, { location: '/final' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('final-response');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const lookupImpl = async () => [{ address: '127.0.0.1' }];
  const isPrivate = () => false;

  try {
    const response = await fetchPinned(`http://redirect-test.invalid:${port}/start`, { lookupImpl, isPrivate });
    const body = await response.text();

    assert.equal(hits, 2);
    assert.equal(body, 'final-response');
  } finally {
    server.close();
  }
});
