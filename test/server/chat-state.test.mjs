import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin / mute / archive: POST /chats/:chatId/state toggles per-chat state; the
// /chats list hides archived chats and keeps pinned ones regardless of age.
const accountId = 'chat-state-account';
const oldChat = '15551110000@s.whatsapp.net';
const freshChat = '15552220000@s.whatsapp.net';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-chat-state-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

const nowSeconds = Math.floor(Date.now() / 1000);
provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });
provider.__test.seedChat(accountId, { id: freshChat, name: 'Fresh', lastMessage: { body: 'hi', text: 'hi', timestamp: nowSeconds } });
provider.__test.seedChat(accountId, { id: oldChat, name: 'Ancient', lastMessage: { body: 'old', text: 'old', timestamp: nowSeconds - 60 * 60 * 24 * 400 } });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'chat-state-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];
const listChats = async (qs = '') => (await (await fetch(`${base}/api/app/accounts/${accountId}/chats${qs}`, { headers: { cookie } })).json());
const setState = (chatId, body) => fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/state`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('an old chat is outside the recency window until it is pinned', async () => {
  assert.equal((await listChats()).some(c => c.id === oldChat), false);
  const response = await setState(oldChat, { pin: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).chat.pinned, true);
  const list = await listChats();
  assert.equal(list[0].id, oldChat, 'a pinned chat sorts to the top');
});

test('archiving removes a chat from the default list and surfaces it under ?archived=1', async () => {
  await setState(freshChat, { archive: true });
  assert.equal((await listChats()).some(c => c.id === freshChat), false);
  const archived = await listChats('?archived=1');
  assert.equal(archived.some(c => c.id === freshChat), true);
  await setState(freshChat, { archive: false });
  assert.equal((await listChats()).some(c => c.id === freshChat), true);
});

test('muting sets a future mutedUntil / muted flag', async () => {
  const response = await setState(freshChat, { mute: 3600 });
  const body = await response.json();
  assert.equal(body.chat.muted, true);
  await setState(freshChat, { mute: 0 });
  assert.equal((await (await setState(freshChat, { mute: 0 })).json()).chat.muted, false);
});

test('a state body with no recognised key is a 400', async () => {
  const response = await setState(freshChat, { frobnicate: true });
  assert.equal(response.status, 400);
});
