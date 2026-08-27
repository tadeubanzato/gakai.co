import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sending an @-mention: the composer posts the wire-form text ("@<number>")
// plus a `mentions` array of jids, and the adapter must forward those jids to
// the provider so WhatsApp renders the mention pills for recipients.
const accountId = 'send-mention-account';
const groupId = '120363000000000001@g.us';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-send-mention-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId, { ownJid: `${accountId}@s.whatsapp.net` });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'send-mention-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('POST /messages forwards the mentions array to the provider', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/messages`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: groupId, text: 'ping @55119', mentions: ['55119@s.whatsapp.net'] }),
  });
  assert.equal(response.status, 200);

  const [sent] = provider.__test.getSentMessages().slice(-1);
  assert.equal(sent.chatId, groupId);
  assert.equal(sent.text, 'ping @55119');
  assert.deepEqual(sent.mentions, ['55119@s.whatsapp.net']);
});

test('a non-array mentions field is ignored, not forwarded as junk', async () => {
  await fetch(`${base}/api/app/accounts/${accountId}/messages`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: groupId, text: 'no mentions here', mentions: 'oops' }),
  });
  const [sent] = provider.__test.getSentMessages().slice(-1);
  assert.deepEqual(sent.mentions, []);
});

test('non-string / oversized mention entries are filtered out', async () => {
  await fetch(`${base}/api/app/accounts/${accountId}/messages`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: groupId, text: 'hi @55119', mentions: ['55119@s.whatsapp.net', 42, 'x'.repeat(200)] }),
  });
  const [sent] = provider.__test.getSentMessages().slice(-1);
  assert.deepEqual(sent.mentions, ['55119@s.whatsapp.net']);
});
