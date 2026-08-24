import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-account-delete-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, store, provider } = await import('../../server.mjs');
after(() => server.close());

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
  provider.__test.seedAccount(accountId);
  provider.__test.seedMessage(accountId, 'demo@s.whatsapp.net', { id: 'demo-message', timestamp: Math.floor(Date.now() / 1000), fromMe: false, body: 'hi', text: 'hi', hasMedia: false });

  const keyResponse = await fetch(`${base}/api/app/accounts/${accountId}/integration-keys/n8n`, { method: 'POST', headers: authed() });
  assert.equal(keyResponse.status, 200);

  const reactionResponse = await fetch(`${base}/api/app/accounts/${accountId}/messages/demo-message/reaction`, {
    method: 'POST', headers: authed(), body: JSON.stringify({ reaction: '\u{1F44D}' }),
  });
  assert.equal(reactionResponse.status, 200);
  assert.equal(provider.__test.getReaction(accountId, 'demo-message'), '\u{1F44D}', 'the reaction must actually be seeded before deletion');
  assert.ok(store.keys.some(item => item.accountId === accountId), 'the integration key must actually be seeded before deletion');

  const deleteResponse = await fetch(`${base}/api/app/accounts/${accountId}`, { method: 'DELETE', headers: authed() });
  assert.equal(deleteResponse.status, 200);

  assert.equal(provider.__test.getReaction(accountId, 'demo-message'), null, 'message reactions must not survive account deletion');
  assert.equal(store.keys.some(item => item.accountId === accountId), false, 'integration keys must not survive account deletion');
});
