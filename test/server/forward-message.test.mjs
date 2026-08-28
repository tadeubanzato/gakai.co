import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Forwarding: POST /messages/:id/forward with { fromChatId, toChatId } hands the
// stored raw message + target chat to the adapter, and the response matches the
// text-send shape ({ chatId, message }).
const accountId = 'forward-account';
const fromChat = '15551110000@s.whatsapp.net';
const toChat = '15552220000@s.whatsapp.net';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-forward-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });
provider.__test.seedMessage(accountId, fromChat, { id: 'msg-to-forward', timestamp: 1735690000, fromMe: false, body: 'hello there', text: 'hello there' });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'forward-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('POST /messages/:id/forward forwards the stored message to the target chat', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/messages/msg-to-forward/forward`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ fromChatId: fromChat, toChatId: toChat }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.chatId, toChat);
  assert.equal(body.message.body, 'hello there');
  assert.equal(body.message.fromMe, true);

  const [sent] = provider.__test.getSentMessages().slice(-1);
  assert.equal(sent.kind, 'forward');
  assert.equal(sent.fromChatId, fromChat);
  assert.equal(sent.toChatId, toChat);
  assert.equal(sent.messageId, 'msg-to-forward');
});

test('forwarding requires fromChatId and toChatId', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/messages/msg-to-forward/forward`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ toChatId: toChat }),
  });
  assert.equal(response.status, 400);
});

test('forwarding an unknown message id is a 404', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/messages/nope/forward`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ fromChatId: fromChat, toChatId: toChat }),
  });
  assert.equal(response.status, 404);
});
