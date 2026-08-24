import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Math.floor(Date.now() / 1000);
const day = 24 * 60 * 60;
const accountId = 'limit-account';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-inbox-limit-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';
process.env.GAKAI_INBOX_CHAT_LIMIT = '3';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId);
// More chats than the (deliberately small, for a fast/deterministic test) cap.
for (let index = 0; index < 6; index++) {
  provider.__test.seedChat(accountId, {
    id: `chat-${index}@s.whatsapp.net`, name: `Chat ${index}`,
    lastMessage: { timestamp: now - index * day, body: `message ${index}`, text: `message ${index}`, hasMedia: false, system: null },
  });
}

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

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
  assert.deepEqual(chats.map(c => c.id), ['chat-0@s.whatsapp.net', 'chat-1@s.whatsapp.net', 'chat-2@s.whatsapp.net'], 'must keep the 3 most recent, not an arbitrary 3');
});
