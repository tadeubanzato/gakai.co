import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const accountId = 'avatar-fallback-account';
const ownJid = '19132185534@s.whatsapp.net';
const chatPictureUrl = 'https://pps.whatsapp.net/v/fallback-photo.jpg';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-account-avatar-fallback-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

// Simulates the observed provider behavior for one connected account: the
// contact-scoped profile-picture lookup returns no photo for the account's
// own identity, even though a real photo exists elsewhere and the
// chat-scoped picture lookup (used for every other chat's avatar) resolves
// it just fine.
provider.__test.seedAccount(accountId, { status: 'WORKING', phone: '19132185534', profile: 'Okame Bot', ownJid });
provider.__test.seedContact(accountId, { id: ownJid, phone: '19132185534', name: 'Okame Bot', picture: chatPictureUrl });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'avatar-fallback-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('an account resolves its own avatar from the contact store', async () => {
  const response = await fetch(`${base}/api/app/accounts`, { headers: { cookie } });
  const { accounts } = await response.json();

  assert.equal(response.status, 200);
  const found = accounts.find(item => item.id === accountId);
  assert.ok(found, 'the seeded account must be present');
  assert.equal(found.picture, chatPictureUrl);
});
