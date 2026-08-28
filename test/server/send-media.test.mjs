import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sending media: the composer POSTs raw file bytes with the mimetype in the
// Content-Type header and chatId/caption in the query string; the adapter must
// receive a Buffer plus the derived kind, and the response shape must match the
// text-send path ({ message }).
const accountId = 'send-media-account';
const chatId = '15550001111@s.whatsapp.net';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-send-media-'));
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
  body: JSON.stringify({ username: 'send-media-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('POST /media forwards a Buffer, mimetype, filename and caption to the provider', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // fake PNG header
  const response = await fetch(`${base}/api/app/accounts/${accountId}/media?chatId=${encodeURIComponent(chatId)}&caption=${encodeURIComponent('a photo')}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/png', 'x-gakai-filename': 'shot.png' },
    body: bytes,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.message, 'response has a message, like the text-send path');
  assert.equal(body.message.hasMedia, true);

  const [sent] = provider.__test.getSentMessages().slice(-1);
  assert.equal(sent.chatId, chatId);
  assert.equal(sent.kind, 'image');
  assert.equal(sent.mimetype, 'image/png');
  assert.equal(sent.filename, 'shot.png');
  assert.equal(sent.caption, 'a photo');
  assert.equal(sent.bytes, bytes.length);
});

test('voice=1 sends as a voice note (audio + ptt)', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/media?chatId=${encodeURIComponent(chatId)}&voice=1`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'audio/ogg; codecs=opus' },
    body: Buffer.from('fake-opus'),
  });
  assert.equal(response.status, 200);
  const [sent] = provider.__test.getSentMessages().slice(-1);
  assert.equal(sent.kind, 'audio');
  assert.equal(sent.ptt, true);
});

test('a missing chatId is rejected', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/media`, {
    method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: Buffer.from('x'),
  });
  assert.equal(response.status, 400);
});

test('an unsupported content type is rejected', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/media?chatId=${encodeURIComponent(chatId)}`, {
    method: 'POST', headers: { cookie, 'content-type': 'font/woff2' }, body: Buffer.from('x'),
  });
  assert.equal(response.status, 415);
});

test('the media endpoint requires an authenticated session', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/media?chatId=${encodeURIComponent(chatId)}`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from('x'),
  });
  assert.equal(response.status, 401);
});
