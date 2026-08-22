import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { URL as NodeURL } from 'node:url';

// "Truth" the mock provider serves from, always sorted desc by timestamp —
// mirrors what a real WAHA engine would return for
// GET /api/{session}/chats/{chatId}/messages.
let truth = [100, 90, 80, 70, 60].map(timestamp => ({
  id: { _serialized: `msg-${timestamp}` }, timestamp, fromMe: false, body: `message at ${timestamp}`, hasMedia: false,
}));

let lastQuery = null;
const mockProvider = http.createServer((req, res) => {
  const requestUrl = new NodeURL(req.url, 'http://mock-provider');
  lastQuery = requestUrl.searchParams;
  const limit = Number(requestUrl.searchParams.get('limit')) || 15;
  const lte = requestUrl.searchParams.get('filter.timestamp.lte');
  const offset = Number(requestUrl.searchParams.get('offset')) || 0;

  let page;
  if (lte !== null) {
    page = truth.filter(message => message.timestamp <= Number(lte)).slice(0, limit);
  } else {
    page = truth.slice(offset, offset + limit);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(page));
});
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockProviderPort = mockProvider.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-before-cursor-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;

const { server } = await import('../../server.mjs');
after(() => { server.close(); mockProvider.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'cursor-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];
const accountId = 'cursor-account';
const chatId = 'cursor-chat@c.us';

test('the first page with no cursor uses offset=0', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/messages?chatId=${encodeURIComponent(chatId)}&limit=2`, { headers: { cookie } });
  const messages = await response.json();
  assert.equal(response.status, 200);
  assert.equal(lastQuery.get('offset'), '0');
  assert.equal(lastQuery.has('filter.timestamp.lte'), false);
  assert.deepEqual(messages.map(m => m.timestamp), [90, 100]); // server re-sorts ascending for the client
});

test('paging older by timestamp is immune to a new message inserted above the loaded page', async () => {
  // Simulate a live message arriving between the two page loads — this is
  // exactly the drift that broke offset-based pagination: it shifts every
  // index below it by one.
  truth = [{ id: { _serialized: 'msg-105' }, timestamp: 105, fromMe: false, body: 'message at 105', hasMedia: false }, ...truth];

  const oldestLoaded = 90; // from the first page above
  const response = await fetch(`${base}/api/app/accounts/${accountId}/messages?chatId=${encodeURIComponent(chatId)}&limit=2&before=${oldestLoaded}`, { headers: { cookie } });
  const messages = await response.json();

  assert.equal(response.status, 200);
  assert.equal(lastQuery.get('filter.timestamp.lte'), String(oldestLoaded - 1));
  assert.equal(lastQuery.has('offset'), false, 'a before-cursor request must not also send offset');
  // Must be exactly the next older page — no duplicate of 90 (which an
  // offset-based request would have re-served after the insertion above it)
  // and no skip of 70.
  assert.deepEqual(messages.map(m => m.timestamp), [70, 80]);
});
