import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Starting a new conversation: POST /chats with { phone } checks the number is
// on WhatsApp (adapter.checkOnWhatsApp), creates the chat row, and returns the
// same overview shape the inbox list consumes.
const accountId = 'start-convo-account';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-start-convo-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });
provider.__test.seedWhatsAppNumber('15551230000');

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'start-convo-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('POST /chats opens a conversation for a number that is on WhatsApp', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '+1 (555) 123-0000' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.chat.id, '15551230000@s.whatsapp.net');
  assert.equal(body.chat.name, '+15551230000');
  assert.equal(body.chat.unreadCount, 0);
});

test('POST /chats rejects a number that is not on WhatsApp', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '15559999999' }),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.message, /not on WhatsApp/i);
});

test('POST /chats rejects an empty phone number', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '' }),
  });
  assert.equal(response.status, 400);
});
