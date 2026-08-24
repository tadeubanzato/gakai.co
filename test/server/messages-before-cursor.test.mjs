import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-before-cursor-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'cursor-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];
const accountId = 'cursor-account';
const chatId = 'cursor-chat@s.whatsapp.net';

provider.__test.seedAccount(accountId);
for (const timestamp of [100, 90, 80, 70, 60]) {
  provider.__test.seedMessage(accountId, chatId, { id: `msg-${timestamp}`, timestamp, fromMe: false, body: `message at ${timestamp}`, text: `message at ${timestamp}`, hasMedia: false });
}

test('the first page with no cursor returns the most recent messages, oldest first for the client', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/messages?chatId=${encodeURIComponent(chatId)}&limit=2`, { headers: { cookie } });
  const messages = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(messages.map(m => m.timestamp), [90, 100]); // server re-sorts ascending for the client
});

test('paging older by timestamp is immune to a new message inserted above the loaded page', async () => {
  // Simulate a live message arriving between the two page loads — this is
  // exactly the drift that would break offset-based pagination: it shifts
  // every index below it by one. A timestamp cursor is unaffected.
  provider.__test.seedMessage(accountId, chatId, { id: 'msg-105', timestamp: 105, fromMe: false, body: 'message at 105', text: 'message at 105', hasMedia: false });

  const oldestLoaded = 90; // from the first page above
  const response = await fetch(`${base}/api/app/accounts/${accountId}/messages?chatId=${encodeURIComponent(chatId)}&limit=2&before=${oldestLoaded}`, { headers: { cookie } });
  const messages = await response.json();

  assert.equal(response.status, 200);
  // Must be exactly the next older page — no duplicate of 90 (which an
  // offset-based request would have re-served after the insertion above it)
  // and no skip of 70.
  assert.deepEqual(messages.map(m => m.timestamp), [70, 80]);
});
