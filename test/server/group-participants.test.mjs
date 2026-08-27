import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The @-mention menu's data source: GET .../chats/:chatId/participants returns
// the group's other members as { id, name, number }.
const accountId = 'participants-account';
const groupId = '120363000000000002@g.us';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-group-participants-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });
provider.__test.seedGroupParticipants(accountId, groupId, [
  { id: '55119@s.whatsapp.net', name: 'Ana Lima', number: '55119' },
  { id: '55128@s.whatsapp.net', name: 'Bruno', number: '55128' },
]);

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'participants-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('the participants endpoint returns the seeded group members', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(groupId)}/participants`, { headers: { cookie } });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.participants.map(p => p.name), ['Ana Lima', 'Bruno']);
  assert.deepEqual(body.participants.map(p => p.number), ['55119', '55128']);
});

test('the participants endpoint returns an empty list for a chat with none seeded', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent('5511999@s.whatsapp.net')}/participants`, { headers: { cookie } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.participants, []);
});
