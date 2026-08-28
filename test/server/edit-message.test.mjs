import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Editing: PATCH /chats/:chatId/messages/:messageId with { text } re-sends the
// text with the original key and rewrites the stored message.
const accountId = 'edit-account';
const chatId = '15551110000@s.whatsapp.net';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-edit-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });
provider.__test.seedMessage(accountId, chatId, { id: 'mine-1', timestamp: 1735690000, fromMe: true, body: 'orignal typo', text: 'orignal typo' });
provider.__test.seedMessage(accountId, chatId, { id: 'theirs-1', timestamp: 1735690001, fromMe: false, body: 'hello', text: 'hello' });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'edit-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('PATCH edits the account\'s own message and returns it flagged edited', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages/mine-1`, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'original, fixed' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.message.body, 'original, fixed');
  assert.equal(body.message.edited, true);

  const [sent] = provider.__test.getSentMessages().slice(-1);
  assert.equal(sent.kind, 'edit');
  assert.equal(sent.messageId, 'mine-1');
});

test('editing someone else\'s message is refused', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages/theirs-1`, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'nope' }),
  });
  assert.equal(response.status, 403);
});

test('an empty edit is rejected', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages/mine-1`, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });
  assert.equal(response.status, 400);
});
