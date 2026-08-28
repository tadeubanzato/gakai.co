import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Starring: POST /messages/:id/star toggles a per-message flag; GET /starred
// returns the flat cross-chat list.
const accountId = 'star-account';
const chatA = '15551110000@s.whatsapp.net';
const chatB = '15552220000@s.whatsapp.net';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-star-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });
provider.__test.seedMessage(accountId, chatA, { id: 'a1', timestamp: 100, fromMe: false, body: 'from A', text: 'from A' });
provider.__test.seedMessage(accountId, chatB, { id: 'b1', timestamp: 200, fromMe: true, body: 'from B', text: 'from B' });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'star-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];
const star = (chatId, messageId, starred) => fetch(`${base}/api/app/accounts/${accountId}/messages/${messageId}/star`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ chatId, starred }),
});

test('starring a message surfaces it under GET /starred with its chatId', async () => {
  assert.equal((await star(chatA, 'a1', true)).status, 200);
  assert.equal((await star(chatB, 'b1', true)).status, 200);
  const { messages } = await (await fetch(`${base}/api/app/accounts/${accountId}/starred`, { headers: { cookie } })).json();
  assert.equal(messages.length, 2);
  assert.ok(messages.every(m => m.starred === true && m.chatId));
});

test('a page load reflects the starred flag on the message', async () => {
  const page = await (await fetch(`${base}/api/app/accounts/${accountId}/messages?chatId=${encodeURIComponent(chatA)}`, { headers: { cookie } })).json();
  const a1 = page.find(m => m.id === 'a1');
  assert.equal(a1.starred, true);
});

test('unstarring removes it from the list', async () => {
  await star(chatA, 'a1', false);
  const { messages } = await (await fetch(`${base}/api/app/accounts/${accountId}/starred`, { headers: { cookie } })).json();
  assert.equal(messages.some(m => m.id === 'a1'), false);
});

test('starring an unknown message is a 404', async () => {
  assert.equal((await star(chatA, 'nope', true)).status, 404);
});
