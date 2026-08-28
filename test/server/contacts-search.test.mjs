import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The "new chat" number field suggests already-synced contacts. The endpoint
// filters by name or phone and only returns contacts that actually have a
// phone number (a jid alone can't seed the field).
const accountId = 'contacts-search-account';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-contacts-search-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });
provider.__test.seedContact(accountId, { id: '15551110001@s.whatsapp.net', name: 'Ada Lovelace', phone: '15551110001' });
provider.__test.seedContact(accountId, { id: '15552220002@s.whatsapp.net', name: 'Alan Turing', phone: '15552220002' });
provider.__test.seedContact(accountId, { id: '15553330003@lid', name: 'No Number', phone: null });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'contacts-search-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('filters contacts by name', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/contacts?q=ada`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const { contacts } = await response.json();
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].name, 'Ada Lovelace');
});

test('filters contacts by phone digits', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/contacts?q=5552220`, { headers: { cookie } });
  const { contacts } = await response.json();
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone, '15552220002');
});

test('a contact with no phone number is never suggested', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/contacts?q=number`, { headers: { cookie } });
  const { contacts } = await response.json();
  assert.equal(contacts.length, 0);
});
