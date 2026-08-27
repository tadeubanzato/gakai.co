import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The inbox paints its list text first, then hydrates avatars separately
// through /chats/pictures so ~40 WhatsApp profile-picture lookups never block
// the first render.
const accountId = 'chats-pictures-account';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-chats-pictures-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });
provider.__test.seedContact(accountId, { id: '55119@s.whatsapp.net', name: 'Ana', picture: 'https://pps.example/ana.jpg' });
provider.__test.seedContact(accountId, { id: '55128@s.whatsapp.net', name: 'Bruno', picture: null });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'chats-pictures-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('/chats/pictures returns a jid -> url map, omitting the ones with no picture', async () => {
  const ids = ['55119@s.whatsapp.net', '55128@s.whatsapp.net', '55199@s.whatsapp.net'].map(encodeURIComponent).join(',');
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/pictures?ids=${ids}`, { headers: { cookie } });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.pictures, { '55119@s.whatsapp.net': 'https://pps.example/ana.jpg' });
});

test('/chats/pictures with no ids is an empty map, not an error', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats/pictures?ids=`, { headers: { cookie } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.pictures, {});
});
