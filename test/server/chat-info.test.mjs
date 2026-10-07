import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME_DATA_DIR = await mkdtemp(join(tmpdir(), 'gakai-chat-info-'));
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const setup = await fetch(`${base}/api/app/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'info-admin', password: 'a-long-enough-password' }) });
const cookie = setup.headers.get('set-cookie').split(';')[0];
const ACCOUNT = 'info-account';
provider.__test.seedAccount(ACCOUNT, { ownJid: '15550001111@s.whatsapp.net' });
const info = (chatId, headers = { cookie }) => fetch(`${base}/api/app/accounts/${ACCOUNT}/chats/${encodeURIComponent(chatId)}/info`, { headers });

const GROUP = '120363025246125486@g.us';
provider.__test.seedContact(ACCOUNT, { id: '5511943346620@s.whatsapp.net', name: 'Mom', phone: '5511943346620' });
provider.__test.seedChatDetails(ACCOUNT, '5511943346620@s.whatsapp.net', { about: 'Hey there!' });
provider.__test.seedGroupParticipants(ACCOUNT, GROUP, [{ id: 'a@s.whatsapp.net', number: 'a', name: 'Ana' }, { id: 'b@s.whatsapp.net', number: 'b', name: 'Bruno' }]);
provider.__test.seedChatDetails(ACCOUNT, GROUP, { group: { subject: 'Carteado', desc: 'Sextas às 20h', creation: 1700000000, owner: 'a@s.whatsapp.net', participants: [{ id: 'b@s.whatsapp.net' }, { id: 'a@s.whatsapp.net', admin: 'superadmin' }] } });

test('a person\'s details: name, number and About', async () => {
  const response = await info('5511943346620@s.whatsapp.net');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.kind, 'person');
  assert.equal(body.name, 'Mom');
  assert.equal(body.phone, '5511943346620');
  assert.equal(body.about, 'Hey there!');
});

test('a group\'s details: description, who made it, and its members with admins first', async () => {
  const body = await (await info(GROUP)).json();
  assert.equal(body.kind, 'group');
  assert.equal(body.name, 'Carteado');
  assert.equal(body.description, 'Sextas às 20h');
  assert.deepEqual(body.createdBy, { id: 'a@s.whatsapp.net', name: 'Ana' });
  assert.deepEqual(body.members.map(member => [member.name, member.admin]), [['Ana', 'superadmin'], ['Bruno', null]]);
});

test('a group WhatsApp will not describe is a 404 with a clear message, and a non-conversation id is a 400', async () => {
  const missing = await info('120363000000000000@g.us');
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).message, /aren't available/);
  assert.equal((await info('status@broadcast')).status, 400);
});

test('details need a signed-in administrator', async () => {
  assert.equal((await info(GROUP, {})).status, 401);
});
