import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Block/unblock and disappearing-messages toggles.
const accountId = 'block-account';
const dmChat = '15551110000@s.whatsapp.net';
const groupChat = '120363000000000001@g.us';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-block-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });
provider.__test.seedChat(accountId, { id: dmChat, name: 'Person', lastMessage: { body: 'hi', text: 'hi', timestamp: Math.floor(Date.now() / 1000) } });
provider.__test.seedChat(accountId, { id: groupChat, name: 'Group', lastMessage: { body: 'hi', text: 'hi', timestamp: Math.floor(Date.now() / 1000) } });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'block-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];
const post = (path, body) => fetch(`${base}/api/app/accounts/${accountId}${path}`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const listChats = async () => (await (await fetch(`${base}/api/app/accounts/${accountId}/chats`, { headers: { cookie } })).json());

test('blocking then unblocking a 1:1 contact flips the blocked flag on the chat overview', async () => {
  assert.equal((await post(`/chats/${encodeURIComponent(dmChat)}/block`, { blocked: true })).status, 200);
  assert.equal((await listChats()).find(c => c.id === dmChat).blocked, true);
  await post(`/chats/${encodeURIComponent(dmChat)}/block`, { blocked: false });
  assert.equal((await listChats()).find(c => c.id === dmChat).blocked, false);
});

test('blocking a group is refused', async () => {
  const response = await post(`/chats/${encodeURIComponent(groupChat)}/block`, { blocked: true });
  assert.equal(response.status, 400);
});

test('setting disappearing messages stores the duration on the chat', async () => {
  const response = await post(`/chats/${encodeURIComponent(dmChat)}/disappearing`, { seconds: 604800 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).chat.ephemeral, 604800);
  assert.equal((await listChats()).find(c => c.id === dmChat).ephemeral, 604800);
});

test('an out-of-range disappearing duration is clamped', async () => {
  const response = await post(`/chats/${encodeURIComponent(dmChat)}/disappearing`, { seconds: 999999999 });
  assert.equal((await response.json()).chat.ephemeral, 60 * 60 * 24 * 90);
});
