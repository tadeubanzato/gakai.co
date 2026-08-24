import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-delete-message-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const accountId = 'delete-message-account';
const chatId = 'chat-partner@s.whatsapp.net';

provider.__test.seedAccount(accountId);

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'delete-message-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('deleting a message removes it from that specific chat, not the whole chat', async () => {
  const messageId = 'ABC123';
  provider.__test.seedMessage(accountId, chatId, { id: messageId, timestamp: 100, fromMe: true, body: 'gone soon', text: 'gone soon', hasMedia: false });

  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE', headers: { cookie },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(await provider.getMessage(accountId, chatId, messageId), null);
});

test('deleting a message also removes any stored reaction for it', async () => {
  const messageId = 'DEF456';
  provider.__test.seedMessage(accountId, chatId, { id: messageId, timestamp: 200, fromMe: false, body: 'react to me', text: 'react to me', hasMedia: false });
  await provider.setReaction(accountId, chatId, messageId, '\u{1F44D}');
  assert.equal(provider.__test.getReaction(accountId, messageId), '\u{1F44D}');

  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE', headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(provider.__test.getReaction(accountId, messageId), null);
});

test('deleting a whole chat still works and is not shadowed by the message-delete route', async () => {
  provider.__test.seedChat(accountId, { id: chatId, name: 'Chat Partner', lastMessage: { body: 'hi', text: 'hi', timestamp: 300, hasMedia: false, system: null } });

  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}`, {
    method: 'DELETE', headers: { cookie },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal((await provider.getChatsOverview(accountId)).some(chat => chat.id === chatId), false);
});
