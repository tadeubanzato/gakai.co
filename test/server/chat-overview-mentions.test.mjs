import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { URL as NodeURL } from 'node:url';

const now = Math.floor(Date.now() / 1000);
const mentionedId = '89249571455071';
const chatId = 'group-chat@g.us';

const chatOverviews = [
  {
    id: chatId, name: 'Family Group', picture: '/api/files/fixture.jpg',
    lastMessage: { body: `Valeu @${mentionedId} !`, text: `Valeu @${mentionedId} !`, timestamp: now, hasMedia: false },
  },
];

const mockProvider = http.createServer((req, res) => {
  const requestUrl = new NodeURL(req.url, 'http://mock-provider');
  res.writeHead(200, { 'content-type': 'application/json' });
  if (requestUrl.pathname.endsWith('/chats/overview')) {
    const offset = Number(requestUrl.searchParams.get('offset')) || 0;
    res.end(JSON.stringify(offset === 0 ? chatOverviews : []));
  } else if (requestUrl.pathname.endsWith('/contacts/all')) {
    res.end(JSON.stringify([{ id: `${mentionedId}@lid`, lid: `${mentionedId}@lid`, name: 'Erica Tanaka' }]));
  } else {
    // /lids/{id}, /contacts/profile-picture, etc. — a generic 200 is enough
    // for resolveContact to proceed without throwing.
    res.end('{}');
  }
});
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockProviderPort = mockProvider.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-chat-overview-mentions-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;

const { server } = await import('../../server.mjs');
after(() => { server.close(); mockProvider.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const accountId = 'mentions-account';

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'mentions-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('the inbox list preview resolves @123456 mentions to real names, same as the reply preview', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, { headers: { cookie } });
  const chats = await response.json();

  assert.equal(response.status, 200);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].lastMessage.body, 'Valeu @Erica Tanaka !');
  assert.equal(chats[0].lastMessage.text, 'Valeu @Erica Tanaka !');
});
