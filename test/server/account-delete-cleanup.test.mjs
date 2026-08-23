import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// Minimal stand-in for the WAHA provider: accepts any request and returns an
// empty JSON body, which is enough for the routes under test (reaction PUT,
// account DELETE) to proceed without needing a real WhatsApp session.
const mockProvider = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockProviderPort = mockProvider.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-account-delete-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;

const { server, store } = await import('../../server.mjs');
after(() => { server.close(); mockProvider.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'cleanup-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];
const authed = extra => ({ 'content-type': 'application/json', cookie, ...extra });

test('deleting an account removes its integration keys and message reactions, not just the well-known collections', async () => {
  const accountId = 'cleanup-account';

  const keyResponse = await fetch(`${base}/api/app/accounts/${accountId}/integration-keys/n8n`, { method: 'POST', headers: authed() });
  assert.equal(keyResponse.status, 200);

  const reactionResponse = await fetch(`${base}/api/app/accounts/${accountId}/messages/demo-message/reaction`, {
    method: 'POST', headers: authed(), body: JSON.stringify({ reaction: '👍' }),
  });
  assert.equal(reactionResponse.status, 200);
  assert.ok(store.messageReactions.some(item => item.accountId === accountId), 'the reaction must actually be seeded before deletion');
  assert.ok(store.keys.some(item => item.accountId === accountId), 'the integration key must actually be seeded before deletion');

  const deleteResponse = await fetch(`${base}/api/app/accounts/${accountId}`, { method: 'DELETE', headers: authed() });
  assert.equal(deleteResponse.status, 200);

  assert.equal(store.messageReactions.some(item => item.accountId === accountId), false, 'message reactions must not survive account deletion');
  assert.equal(store.keys.some(item => item.accountId === accountId), false, 'integration keys must not survive account deletion');
});
