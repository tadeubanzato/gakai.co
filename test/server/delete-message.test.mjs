import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { URL as NodeURL } from 'node:url';

const deleteCalls = [];
const mockProvider = http.createServer((req, res) => {
  if (req.method === 'DELETE') {
    deleteCalls.push(new NodeURL(req.url, 'http://mock-provider').pathname);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockProviderPort = mockProvider.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-delete-message-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;

const { server, store } = await import('../../server.mjs');
after(() => { server.close(); mockProvider.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const accountId = 'delete-message-account';
const chatId = 'chat-partner@c.us';

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'delete-message-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('deleting a message calls the provider chat-scoped message delete endpoint, not the whole-chat one', async () => {
  const messageId = 'true_chat-partner@c.us_ABC123';
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE', headers: { cookie },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0], `/api/${accountId}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`);
});

test('deleting a message also removes any stored reaction for it', async () => {
  const messageId = 'true_chat-partner@c.us_DEF456';
  store.messageReactions.push({ accountId, messageId, reaction: '👍', reactedAt: new Date().toISOString() });
  assert.ok(store.messageReactions.some(item => item.messageId === messageId));

  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE', headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(store.messageReactions.some(item => item.messageId === messageId), false);
});

test('deleting a whole chat still works and is not shadowed by the message-delete route', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}`, {
    method: 'DELETE', headers: { cookie },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.ok(store.deletedChats.some(item => item.accountId === accountId && item.chatId === chatId));
});
