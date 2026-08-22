import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { URL as NodeURL } from 'node:url';

const now = Math.floor(Date.now() / 1000);
const day = 24 * 60 * 60;

// Fixed set of chats: a mix of recent, stale (older than the 60-day default
// recency window), and one Gakai has recorded as deleted.
const chatOverviews = [
  { id: 'recent-1@c.us', name: 'Recent 1', lastMessage: { timestamp: now - 1 * day, body: 'hi' } },
  { id: 'recent-2@c.us', name: 'Recent 2', lastMessage: { timestamp: now - 5 * day, body: 'hey' } },
  { id: 'stale-1@c.us', name: 'Stale 1', lastMessage: { timestamp: now - 120 * day, body: 'old' } },
  { id: 'stale-2@c.us', name: 'Stale 2', lastMessage: { timestamp: now - 400 * day, body: 'older' } },
  { id: 'deleted-in-gakai@c.us', name: 'Deleted in Gakai', lastMessage: { timestamp: now - 2 * day, body: 'gone' } },
  // A resync "ghost": fresh timestamp, but no real message behind it (WAHA/WEBJS
  // observed doing this — several chats sharing one identical touched
  // timestamp with empty body/text and hasMedia:false).
  { id: 'ghost@lid', name: 'Ghost Contact', lastMessage: { timestamp: now, body: '', text: '', hasMedia: false } },
];

const mockProvider = http.createServer((req, res) => {
  const requestUrl = new NodeURL(req.url, 'http://mock-provider');
  if (requestUrl.pathname.endsWith('/chats/overview')) {
    const offset = Number(requestUrl.searchParams.get('offset')) || 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(offset === 0 ? chatOverviews : []));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockProviderPort = mockProvider.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-inbox-recency-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;

const { server, store } = await import('../../server.mjs');
after(() => { server.close(); mockProvider.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const accountId = 'recency-account';

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'recency-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];
store.deletedChats.push({ accountId, chatId: 'deleted-in-gakai@c.us', deletedAt: new Date().toISOString() });

test('the inbox excludes chats with no activity in the recency window, even when fewer than 30 chats exist', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, { headers: { cookie } });
  const chats = await response.json();

  assert.equal(response.status, 200);
  const ids = chats.map(c => c.id).sort();
  assert.deepEqual(ids, ['recent-1@c.us', 'recent-2@c.us'], 'stale chats, the Gakai-deleted chat, and the fresh-timestamp-no-content ghost must not pad out the list');
});

test('the most recently active chat sorts first', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, { headers: { cookie } });
  const chats = await response.json();
  assert.equal(chats[0].id, 'recent-1@c.us'); // 1 day ago, more recent than recent-2's 5 days ago
});
