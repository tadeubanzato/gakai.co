import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-read-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => { server.close(); });
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const setup = await fetch(`${base}/api/app/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'read-admin', password: 'a-long-enough-password' }) });
const cookie = setup.headers.get('set-cookie').split(';')[0];
const ACCOUNT = 'read-account';
const CHAT = '5511999777057@s.whatsapp.net';
provider.__test.seedAccount(ACCOUNT, { ownJid: '18577075969:12@s.whatsapp.net' });

const read = (body) => fetch(`${base}/api/app/accounts/${ACCOUNT}/chats/${encodeURIComponent(CHAT)}/read`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const incoming = (id, timestamp) => provider.__test.simulateIncomingMessage(ACCOUNT, CHAT, { id, body: id, timestamp });
const T = Math.floor(Date.now() / 1000) - 600;
const unread = async () => {
  const body = await (await fetch(`${base}/api/app/accounts/${ACCOUNT}/chats`, { headers: { cookie } })).json();
  return (Array.isArray(body) ? body : body.chats || []).find(chat => chat.id === CHAT)?.unreadCount;
};

test('reading up to a point returns the authoritative remainder; a repeat or stale read changes nothing', async () => {
  incoming('a', T + 0); incoming('b', T + 1); incoming('c', T + 2);
  incoming('b', T + 1);                                   // a duplicate delivery
  assert.equal(await unread(), 3);
  assert.equal((await (await read({ through: T + 1 })).json()).unreadCount, 1);
  assert.equal(await unread(), 1);
  assert.equal((await (await read({ through: T + 0 })).json()).unreadCount, 1, 'a stale, older read cannot undo or redo anything');
  assert.equal((await (await read({ through: T + 2 })).json()).unreadCount, 0);
  assert.equal(await unread(), 0);
});

test('a read with no boundary reads everything, and a new message after it is unread again', async () => {
  incoming('d', T + 10);
  assert.equal((await (await read()).json()).unreadCount, 0);
  incoming('e', T + 11);
  assert.equal(await unread(), 1);
});

test('the account dot reflects real unread state', async () => {
  const dot = async () => (await (await fetch(`${base}/api/app/accounts`, { headers: { cookie } })).json()).accounts.find(item => item.id === ACCOUNT).hasUnread;
  assert.equal(await dot(), true);
  await read({ through: T + 11 });
  assert.equal(await dot(), false);
});

test('one event stream can follow several accounts and carries read changes', async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/app/events?accountId=${ACCOUNT},another-account&after=now`, { headers: { cookie }, signal: controller.signal });
  assert.equal(response.status, 200);
  incoming('s', T + 50);
  await read({ through: T + 50 });
  const reader = response.body.getReader();
  let text = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !text.includes('chat.read')) {
    const { value } = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve({}), 500))]);
    if (value) text += Buffer.from(value).toString();
  }
  controller.abort();
  assert.match(text, /"type":"chat.read"/);
});
