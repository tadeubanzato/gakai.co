import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { URL as NodeURL } from 'node:url';

const accountId = 'avatar-fallback-account';
const meId = '19132185534@c.us';
const chatPictureUrl = 'https://pps.whatsapp.net/v/fallback-photo.jpg';

// Simulates the observed provider behavior for one connected account: the
// contact-scoped profile-picture lookup returns no photo for the account's
// own identity, even though a real photo exists and the chat-scoped picture
// endpoint (used for every other chat's avatar) resolves it just fine.
const mockProvider = http.createServer((req, res) => {
  const requestUrl = new NodeURL(req.url, 'http://mock-provider');
  res.writeHead(200, { 'content-type': 'application/json' });
  if (requestUrl.pathname === '/api/sessions') {
    res.end(JSON.stringify([{ name: accountId, status: 'WORKING', me: { id: meId, pushName: 'Okame Bot' }, config: {} }]));
  } else if (requestUrl.pathname === '/api/contacts/all') {
    res.end(JSON.stringify([{ id: meId, number: '19132185534', isMe: true }]));
  } else if (requestUrl.pathname === '/api/contacts/profile-picture') {
    res.end(JSON.stringify({ profilePictureURL: null }));
  } else if (requestUrl.pathname === `/api/${accountId}/chats/${encodeURIComponent(meId)}/picture`) {
    res.end(JSON.stringify({ url: chatPictureUrl }));
  } else {
    res.end('{}');
  }
});
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockProviderPort = mockProvider.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-account-avatar-fallback-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;

const { server } = await import('../../server.mjs');
after(() => { server.close(); mockProvider.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'avatar-fallback-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('an account whose own contacts/profile-picture lookup comes back empty still gets its avatar via the chat-picture fallback', async () => {
  const response = await fetch(`${base}/api/app/accounts`, { headers: { cookie } });
  const { accounts } = await response.json();

  assert.equal(response.status, 200);
  const found = accounts.find(item => item.id === accountId);
  assert.ok(found, 'the seeded account must be present');
  assert.equal(found.picture, chatPictureUrl);
});
