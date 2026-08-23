import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { URL as NodeURL } from 'node:url';

const now = Math.floor(Date.now() / 1000);
const day = 24 * 60 * 60;

// More chats than the (deliberately small, for a fast/deterministic test) cap.
const chatOverviews = Array.from({ length: 6 }, (_, index) => ({
  id: `chat-${index}@c.us`, name: `Chat ${index}`,
  lastMessage: { timestamp: now - index * day, body: `message ${index}` },
}));

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

const scratch = await mkdtemp(join(tmpdir(), 'gakai-inbox-limit-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;
process.env.GAKAI_INBOX_CHAT_LIMIT = '3';

const { server } = await import('../../server.mjs');
after(() => { server.close(); mockProvider.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const accountId = 'limit-account';

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'limit-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('the inbox caps at GAKAI_INBOX_CHAT_LIMIT, keeping the most recent ones', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, { headers: { cookie } });
  const chats = await response.json();

  assert.equal(response.status, 200);
  assert.equal(chats.length, 3, 'must cap at the configured limit, not the full 6 available');
  assert.deepEqual(chats.map(c => c.id), ['chat-0@c.us', 'chat-1@c.us', 'chat-2@c.us'], 'must keep the 3 most recent, not an arbitrary 3');
});
