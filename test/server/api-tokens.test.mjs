import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-api-tokens-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider, store } = await import('../../server.mjs');
after(() => server.close());
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tokens-admin', password: 'a-long-enough-password' }) });
const cookie = setup.headers.get('set-cookie').split(';')[0];

const ACCOUNT = 'tokens-account';
provider.__test.seedAccount(ACCOUNT);
provider.__test.seedWhatsAppNumber('18577075969');
provider.__test.seedWhatsAppNumber('5511999777057');

const keysUrl = (suffix = '', account = ACCOUNT) => `${base}/api/app/accounts/${account}/integration-keys${suffix}`;
const manage = (method, suffix, body, headers = { cookie }) => fetch(keysUrl(suffix), { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const create = async (name, scopes) => (await manage('POST', '', { name, scopes })).json();
const send = (token, body) => fetch(`${base}/api/integrations/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const sentMessages = () => provider.__test.getSentMessages();

test('only the signed-in administrator can manage tokens', async () => {
  assert.equal((await manage('GET', '', undefined, {})).status, 401);
  assert.equal((await manage('POST', '', { name: 'x' }, {})).status, 401);
});

test('creating a token shows the secret once, and listing never shows it again', async () => {
  const created = await manage('POST', '', { name: '  n8n  ', scopes: ['messages:send'] });
  assert.equal(created.status, 201);
  const { key, token } = await created.json();
  assert.match(token, /^wh_live_/);
  assert.deepEqual({ name: key.name, scopes: key.scopes, last4: key.last4 }, { name: 'n8n', scopes: ['messages:send'], last4: token.slice(-4) });

  const listed = await (await manage('GET', '')).json();
  const row = listed.keys.find(item => item.id === key.id);
  assert.ok(row, 'the token is listed');
  const text = JSON.stringify(listed);
  assert.equal(text.includes(token), false, 'the secret must never be listed');
  assert.equal(/hash/i.test(text), false, 'nor its hash');
});

test('a token needs a name and only known permissions; with none given it can only send', async () => {
  assert.equal((await manage('POST', '', { name: '   ' })).status, 400);
  assert.equal((await manage('POST', '', { name: 'bad', scopes: ['messages:send', 'admin'] })).status, 400);
  assert.equal((await manage('POST', '', { name: 'empty', scopes: [] })).status, 400);
  const { key } = await create('default-scope');
  assert.deepEqual(key.scopes, ['messages:send']);
});

test('a full phone number in any format opens a new chat when there is none, then reuses it', async () => {
  const { token } = await create('crm', ['messages:send']);
  const before = sentMessages().length;

  const first = await send(token, { phone: '+1 (857) 707-5969', text: 'Hello from the CRM' });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.chatId, '18577075969@s.whatsapp.net');
  assert.equal(firstBody.newChat, true, 'no conversation existed, so one was started');

  const second = await (await send(token, { to: '18577075969', text: 'And a follow-up' })).json();
  assert.equal(second.newChat, false, 'the conversation now exists and is reused');
  assert.equal(second.chatId, firstBody.chatId);

  const delivered = sentMessages().slice(before);
  assert.deepEqual(delivered.map(item => [item.accountId, item.chatId, item.text]), [
    [ACCOUNT, '18577075969@s.whatsapp.net', 'Hello from the CRM'],
    [ACCOUNT, '18577075969@s.whatsapp.net', 'And a follow-up'],
  ]);
});

test('an existing conversation is used as it is, not duplicated', async () => {
  provider.__test.seedChat(ACCOUNT, { id: '5511999777057@s.whatsapp.net', name: 'Marina', unreadCount: 0, lastMessageTimestamp: Math.floor(Date.now() / 1000), lastMessage: { body: 'oi', text: 'oi', timestamp: 1 } });
  const { token } = await create('existing-chat', ['messages:send']);
  const body = await (await send(token, { phone: '+55 11 99977-7057', text: 'Oi' })).json();
  assert.equal(body.newChat, false);
  assert.equal(body.chatId, '5511999777057@s.whatsapp.net');
});

test('a number that is not on WhatsApp is refused and nothing is sent', async () => {
  const { token } = await create('unknown-number', ['messages:send']);
  const before = sentMessages().length;
  const response = await send(token, { phone: '+1 555 000 0000', text: 'Hello' });
  assert.equal(response.status, 404);
  assert.match((await response.json()).message, /not on WhatsApp/i);
  assert.equal(sentMessages().length, before);
});

test('bad requests get a clear 400 and send nothing', async () => {
  const { token } = await create('validation', ['messages:send']);
  const before = sentMessages().length;
  for (const body of [{ text: 'no target' }, { phone: 'abc', text: 'hi' }, { phone: '18577075969' }, { phone: '18577075969', text: '   ' }, { chatId: 'nonsense', text: 'hi' }, { phone: '18577075969', text: 'x'.repeat(4097) }]) {
    const response = await send(token, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
    assert.ok((await response.json()).message);
  }
  assert.equal(sentMessages().length, before);
});

test('an explicit chat id (a group, say) is sent to as given', async () => {
  const { token } = await create('group-sender', ['messages:send']);
  const body = await (await send(token, { chatId: '120363025246125486@g.us', text: 'To the group' })).json();
  assert.deepEqual([body.ok, body.chatId, body.newChat], [true, '120363025246125486@g.us', false]);
});

test('permissions are enforced: a read-only token cannot send, a send-only token cannot read', async () => {
  const reader = (await create('reader', ['messages:read'])).token;
  const writer = (await create('writer', ['messages:send'])).token;
  const before = sentMessages().length;
  assert.equal((await send(reader, { phone: '18577075969', text: 'nope' })).status, 403);
  assert.equal(sentMessages().length, before);
  const read = await fetch(`${base}/api/integrations/v1/chats`, { headers: { authorization: `Bearer ${writer}` } });
  assert.equal(read.status, 403);
  assert.equal((await fetch(`${base}/api/integrations/v1/chats`, { headers: { authorization: `Bearer ${reader}` } })).status, 200);
});

test('a wrong or missing token is refused', async () => {
  assert.equal((await send('wh_live_not-a-real-token', { phone: '18577075969', text: 'hi' })).status, 401);
  const none = await fetch(`${base}/api/integrations/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '18577075969', text: 'hi' }) });
  assert.equal(none.status, 401);
});

test('regenerating replaces the secret at once: the old token stops, the new one works, the rest is kept', async () => {
  const { key, token: oldToken } = await create('rotate-me', ['messages:send']);
  assert.equal((await send(oldToken, { phone: '18577075969', text: 'before' })).status, 200);

  const response = await manage('POST', `/${key.id}/regenerate`);
  assert.equal(response.status, 200);
  const rotated = await response.json();
  assert.notEqual(rotated.token, oldToken);
  assert.equal(rotated.key.id, key.id);
  assert.equal(rotated.key.name, 'rotate-me');
  assert.deepEqual(rotated.key.scopes, ['messages:send']);
  assert.ok(rotated.key.rotatedAt);
  assert.equal(rotated.key.lastUsedAt, null, 'usage starts over for the new token');
  assert.equal(rotated.key.last4, rotated.token.slice(-4));

  assert.equal((await send(oldToken, { phone: '18577075969', text: 'after' })).status, 401, 'the old token is dead immediately');
  assert.equal((await send(rotated.token, { phone: '18577075969', text: 'after' })).status, 200);
  assert.equal((await manage('POST', '/does-not-exist/regenerate')).status, 404);
});

test('deleting a token stops it immediately', async () => {
  const { key, token } = await create('delete-me', ['messages:send']);
  assert.equal((await send(token, { phone: '18577075969', text: 'ok' })).status, 200);
  assert.equal((await manage('DELETE', `/${key.id}`)).status, 200);
  assert.equal((await send(token, { phone: '18577075969', text: 'gone' })).status, 401);
  assert.equal((await (await manage('GET', '')).json()).keys.some(item => item.id === key.id), false);
});

test('using a token records when it was last used', async () => {
  const { key, token } = await create('usage', ['messages:send']);
  assert.equal((await (await manage('GET', '')).json()).keys.find(item => item.id === key.id).lastUsedAt, null);
  await send(token, { phone: '18577075969', text: 'ping' });
  assert.ok((await (await manage('GET', '')).json()).keys.find(item => item.id === key.id).lastUsedAt);
});

test('a token belongs to one account: it sends from that account only, and another account cannot manage it', async () => {
  const other = 'tokens-other-account';
  provider.__test.seedAccount(other);
  const { key, token } = await create('scoped', ['messages:send']);
  const before = sentMessages().length;
  await send(token, { phone: '18577075969', text: 'from the right account' });
  assert.equal(sentMessages()[before].accountId, ACCOUNT);
  assert.equal((await fetch(keysUrl(`/${key.id}/regenerate`, other), { method: 'POST', headers: { cookie } })).status, 404, 'the other account cannot rotate it');
  assert.equal((await (await fetch(keysUrl('', other), { headers: { cookie } })).json()).keys.length, 0, 'nor see it');
});

test('the key Gakai manages for n8n auto-connect is not listed or rotatable here', async () => {
  const internal = await (await manage('POST', '/n8n')).json();
  assert.ok(internal.token);
  const listed = (await (await manage('GET', '')).json()).keys;
  assert.equal(listed.some(item => item.name === 'n8n integration'), false);
});

test('an account is limited to 20 tokens', async () => {
  const crowded = 'tokens-crowded-account';
  provider.__test.seedAccount(crowded);
  const make = name => fetch(keysUrl('', crowded), { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name }) });
  for (let index = 0; index < 20; index += 1) assert.equal((await make(`app ${index}`)).status, 201);
  const over = await make('one too many');
  assert.equal(over.status, 409);
  assert.match((await over.json()).message, /20/);
});

test('the country code can be given as 1, +1, 55, +55 or a country name, with or without a + on the number', async () => {
  const { token } = await create('country-codes', ['messages:send']);
  const before = sentMessages().length;
  const cases = [
    [{ phone: '+1 857 707 5969', text: 'plus' }, '18577075969'],
    [{ phone: '18577075969', text: 'no plus' }, '18577075969'],
    [{ phone: '(857) 707-5969', countryCode: '1', text: 'national us' }, '18577075969'],
    [{ phone: '857-707-5969', countryCode: '+1', text: 'national us plus' }, '18577075969'],
    [{ phone: '11 99977-7057', countryCode: '55', text: 'national br' }, '5511999777057'],
    [{ phone: '(11) 99977-7057', countryCode: '+55', text: 'national br plus' }, '5511999777057'],
    [{ phone: '011 99977-7057', countryCode: 'BR', text: 'national br trunk' }, '5511999777057'],
    [{ phone: '0055 11 99977 7057', text: 'international prefix' }, '5511999777057'],
  ];
  for (const [body, digits] of cases) {
    const response = await send(token, body);
    assert.equal(response.status, 200, JSON.stringify(body));
    const reply = await response.json();
    assert.equal(reply.chatId, `${digits}@s.whatsapp.net`, JSON.stringify(body));
    assert.equal(reply.to, `+${digits}`, 'the reply shows the normalized number that was used');
  }
  assert.equal(sentMessages().length - before, cases.length);
});

test('a national number is refused with a clear message when the country cannot be told, and nothing is sent', async () => {
  const { token } = await create('no-country', ['messages:send']);
  const before = sentMessages().length;
  for (const phone of ['(857) 707-5969', '11 99977-7057']) {
    const response = await send(token, { phone, text: 'hi' });
    assert.equal(response.status, 400, phone);
    assert.match((await response.json()).message, /country code/i);
  }
  const badCode = await send(token, { phone: '857 707 5969', countryCode: '999', text: 'hi' });
  assert.equal(badCode.status, 400);
  assert.match((await badCode.json()).message, /countryCode/);
  assert.equal(sentMessages().length, before);
});

test('with no countryCode, the connected account\'s own country completes a national number', async () => {
  const usAccount = 'tokens-us-account';
  provider.__test.seedAccount(usAccount, { phone: '18577075969' });
  const created = await (await fetch(keysUrl('', usAccount), { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'local', scopes: ['messages:send'] }) })).json();
  const response = await send(created.token, { phone: '(857) 707-5969', text: 'same country as this account' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).to, '+18577075969');
  const explicit = await send(created.token, { phone: '11 99977-7057', countryCode: '55', text: 'a Brazilian number from a US account' });
  assert.equal((await explicit.json()).to, '+5511999777057', 'the request\'s country code beats the account default');
});

test('a token\'s permissions can be changed after it is created, and the change applies on its next call', async () => {
  const { key, token } = await create('grows-up'); // a new token can only send
  assert.deepEqual(key.scopes, ['messages:send']);
  const chats = () => fetch(`${base}/api/integrations/v1/chats`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await chats()).status, 403, 'cannot read yet');

  const widened = await manage('PATCH', `/${key.id}`, { scopes: ['messages:send', 'messages:read'] });
  assert.equal(widened.status, 200);
  assert.deepEqual((await widened.json()).key.scopes, ['messages:send', 'messages:read']);
  assert.equal((await chats()).status, 200, 'can read now');
  assert.deepEqual((await (await manage('GET', '')).json()).keys.find(item => item.id === key.id).scopes, ['messages:send', 'messages:read']);

  assert.equal((await manage('PATCH', `/${key.id}`, { scopes: ['messages:read'] })).status, 200);
  assert.equal((await send(token, { phone: '18577075969', text: 'no longer allowed' })).status, 403, 'sending is revoked at once');
});

test('changing permissions refuses none, unknown ones, a missing token, and another account\'s token', async () => {
  const { key } = await create('guarded');
  for (const scopes of [[], ['admin'], ['messages:send', 'root'], 'messages:send']) {
    assert.equal((await manage('PATCH', `/${key.id}`, { scopes })).status, 400, JSON.stringify(scopes));
  }
  assert.deepEqual((await (await manage('GET', '')).json()).keys.find(item => item.id === key.id).scopes, ['messages:send'], 'a refused change leaves the token as it was');
  assert.equal((await manage('PATCH', '/does-not-exist', { scopes: ['messages:send'] })).status, 404);
  const other = 'tokens-patch-other';
  provider.__test.seedAccount(other);
  assert.equal((await fetch(keysUrl(`/${key.id}`, other), { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ scopes: ['messages:read'] }) })).status, 404);
  assert.equal((await manage('PATCH', `/${key.id}`, { scopes: ['messages:send'] }, {})).status, 401, 'signed-out callers cannot change permissions');
});

const HOUR = 60 * 60 * 1000;
const copyToken = (keyId, account = ACCOUNT, headers = { cookie }) => fetch(keysUrl(`/${keyId}/token`, account), { headers });
const ageToken = (keyId, hours) => { const key = store.keys.find(item => item.id === keyId); key.createdAt = new Date(Date.now() - hours * HOUR).toISOString(); delete key.rotatedAt; };

test('a new token can be copied back for 24 hours, and the list says so without revealing it', async () => {
  // Earlier tests filled this account's 20-token allowance; start these from a clean slate.
  store.keys = store.keys.filter(item => item.accountId !== ACCOUNT);
  const { key, token } = await create('copy-me');
  const listed = (await (await manage('GET', '')).json()).keys.find(item => item.id === key.id);
  assert.equal(listed.copyable, true);
  assert.ok(Math.abs(Date.parse(listed.copyableUntil) - (Date.now() + 24 * HOUR)) < 60000, 'the window closes about 24 hours from now');
  assert.equal(JSON.stringify(listed).includes(token), false, 'the list never carries the token');

  const response = await copyToken(key.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).token, token, 'it is the very token that works against the API');
  assert.equal((await send(token, { phone: '18577075969', text: 'still works' })).status, 200);
});

test('the stored copy is encrypted at rest, never the plain token', async () => {
  const { key, token } = await create('encrypted-at-rest');
  const stored = store.keys.find(item => item.id === key.id);
  assert.match(stored.tokenEnc, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/, 'AES-GCM iv:tag:data');
  assert.equal(JSON.stringify(stored).includes(token), false, 'the token appears nowhere in the saved record');
});

test('after 24 hours the token cannot be copied any more, is deleted from storage, and still works for the API', async () => {
  const { key, token } = await create('expires');
  ageToken(key.id, 25);
  const response = await copyToken(key.id);
  assert.equal(response.status, 410);
  assert.match((await response.json()).message, /Regenerate/);
  assert.equal('tokenEnc' in store.keys.find(item => item.id === key.id), false, 'the stored copy is gone for good');
  const listed = (await (await manage('GET', '')).json()).keys.find(item => item.id === key.id);
  assert.deepEqual([listed.copyable, listed.copyableUntil], [false, null]);
  assert.equal((await send(token, { phone: '18577075969', text: 'the window is about copying, not validity' })).status, 200);
});

test('just inside the window it can still be copied', async () => {
  const { key, token } = await create('almost-expired');
  ageToken(key.id, 23.9);
  assert.equal((await (await copyToken(key.id)).json()).token, token);
});

test('regenerating gives a new token and a fresh 24 hours', async () => {
  const { key, token: first } = await create('refresh-window');
  ageToken(key.id, 30);
  assert.equal((await copyToken(key.id)).status, 410);
  const rotated = await (await manage('POST', `/${key.id}/regenerate`)).json();
  const copied = await (await copyToken(key.id)).json();
  assert.equal(copied.token, rotated.token);
  assert.notEqual(copied.token, first);
  assert.equal((await send(first, { phone: '18577075969', text: 'old' })).status, 401);
});

test('a token made before copying existed has nothing stored and cannot be copied', async () => {
  const { key } = await create('legacy');
  delete store.keys.find(item => item.id === key.id).tokenEnc;
  assert.equal((await copyToken(key.id)).status, 410);
});

test('copying is for the signed-in administrator and that account\'s own tokens only', async () => {
  const { key } = await create('guard-copy');
  assert.equal((await copyToken(key.id, ACCOUNT, {})).status, 401, 'signed out');
  const other = 'tokens-copy-other';
  provider.__test.seedAccount(other);
  assert.equal((await copyToken(key.id, other)).status, 404, 'another account');
  assert.equal((await copyToken('does-not-exist')).status, 404);
  await manage('POST', '/n8n');
  const internal = store.keys.find(item => item.accountId === ACCOUNT && item.name === 'n8n integration');
  assert.equal((await copyToken(internal.id)).status, 404, 'the key Gakai manages for n8n is not copyable here');
});

test('deleting a token removes its stored copy with it', async () => {
  const { key } = await create('delete-copy');
  await manage('DELETE', `/${key.id}`);
  assert.equal(store.keys.some(item => item.id === key.id), false);
  assert.equal((await copyToken(key.id)).status, 404);
});

const platformKeys = (headers = { cookie }) => fetch(`${base}/api/app/integration-keys`, { headers });
const platformCreate = (body, headers = { cookie }) => fetch(`${base}/api/app/integration-keys`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the workspace token list spans every profile and says which profile each token belongs to', async () => {
  const second = 'tokens-platform-second';
  provider.__test.seedAccount(second);
  const a = await create('platform-a');
  const b = await (await fetch(keysUrl('', second), { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'platform-b' }) })).json();
  const listed = (await (await platformKeys()).json()).keys;
  assert.equal(listed.find(item => item.id === a.key.id).accountId, ACCOUNT);
  assert.equal(listed.find(item => item.id === b.key.id).accountId, second);
  assert.equal(JSON.stringify(listed).includes(a.token), false, 'still never the secret');
  assert.equal(listed.some(item => item.name === 'n8n integration'), false, 'nor Gakai\'s own n8n key');
});

test('a token can be created from the workspace page for a chosen profile, and it sends from that profile', async () => {
  const other = 'tokens-platform-sender';
  provider.__test.seedAccount(other);
  const response = await platformCreate({ accountId: other, name: 'from-settings', scopes: ['messages:send'] });
  assert.equal(response.status, 201);
  const { key, token } = await response.json();
  assert.equal(key.accountId, other);
  const before = sentMessages().length;
  assert.equal((await send(token, { phone: '18577075969', text: 'sent from the chosen profile' })).status, 200);
  assert.equal(sentMessages()[before].accountId, other);
  assert.equal((await copyToken(key.id, other)).status, 200, 'the same copy window applies');
});

test('creating a workspace token needs a real profile, a valid request, and respects the per-profile limit', async () => {
  assert.equal((await platformCreate({ name: 'no-profile' })).status, 404);
  assert.equal((await platformCreate({ accountId: 'no-such-profile', name: 'x' })).status, 404);
  assert.equal((await platformCreate({ accountId: ACCOUNT, name: '   ' })).status, 400);
  assert.equal((await platformCreate({ accountId: ACCOUNT, name: 'bad', scopes: ['admin'] })).status, 400);
  const crowded = 'tokens-platform-crowded';
  provider.__test.seedAccount(crowded);
  for (let index = 0; index < 20; index += 1) assert.equal((await platformCreate({ accountId: crowded, name: `app ${index}` })).status, 201);
  assert.equal((await platformCreate({ accountId: crowded, name: 'one too many' })).status, 409);
});

test('the workspace token routes are for the signed-in administrator only', async () => {
  assert.equal((await platformKeys({})).status, 401);
  assert.equal((await platformCreate({ accountId: ACCOUNT, name: 'x' }, {})).status, 401);
});

test('the send response names the account the message went out from', async () => {
  const { token } = await create('who-sent', ['messages:send']);
  const response = await send(token, { phone: '18577075969', text: 'who am i' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.account.id, ACCOUNT);
  assert.ok(body.account.label);
  assert.ok('phone' in body.account);
});

test('an accountId that matches the token is accepted', async () => {
  const { token } = await create('guard-ok', ['messages:send']);
  const before = sentMessages().length;
  const response = await send(token, { accountId: ACCOUNT, phone: '18577075969', text: 'guarded' });
  assert.equal(response.status, 200);
  assert.equal(sentMessages().length, before + 1);
});

test('an accountId for a different account is refused and nothing is sent', async () => {
  const { token } = await create('guard-bad', ['messages:send']);
  const before = sentMessages().length;
  const response = await send(token, { accountId: 'some-other-account', phone: '18577075969', text: 'wrong place' });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.match(body.message, /some-other-account/);
  assert.match(body.message, new RegExp(ACCOUNT));
  assert.equal(body.accountId, ACCOUNT);
  assert.equal(sentMessages().length, before, 'no message may go out from the wrong account');
});

test('an empty accountId is the same as leaving it out', async () => {
  const { token } = await create('guard-empty', ['messages:send']);
  assert.equal((await send(token, { accountId: '', phone: '18577075969', text: 'empty id' })).status, 200);
  assert.equal((await send(token, { accountId: null, phone: '18577075969', text: 'null id' })).status, 200);
});

const getAccount = token => fetch(`${base}/api/integrations/v1/account`, { headers: { authorization: `Bearer ${token}` } });

test('a token can ask which account it belongs to, whatever permissions it has', async () => {
  provider.__test.seedAccount('someone-elses-account');
  for (const scopes of [['messages:send'], ['messages:read']]) {
    const { token, key } = await create(`whoami-${scopes[0]}`, scopes);
    const response = await getAccount(token);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.account.id, ACCOUNT);
    assert.ok(body.account.label);
    assert.ok('phone' in body.account && 'status' in body.account);
    assert.equal(body.token.name, key.name);
    assert.deepEqual(body.token.scopes, scopes);
  }
});

test('the account endpoint describes only the token\'s own account and never exposes secrets', async () => {
  const { token } = await create('whoami-private', ['messages:send']);
  const text = await (await getAccount(token)).text();
  assert.equal(text.includes('someone-elses-account'), false);
  assert.equal(text.includes(token), false);
  assert.equal(/hash|tokenEnc|last4/.test(text), false);
});

test('the account endpoint refuses a missing or wrong token', async () => {
  assert.equal((await getAccount('wh_live_not-a-real-token')).status, 401);
  assert.equal((await fetch(`${base}/api/integrations/v1/account`)).status, 401);
});

test('POST to the account endpoint is not a thing', async () => {
  const { token } = await create('whoami-post', ['messages:send']);
  const response = await fetch(`${base}/api/integrations/v1/account`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
});

// An account holds at most 20 tokens and the tests above have made many: clear them before the next group.
test('(setup) clear earlier test tokens', async () => {
  const { keys } = await (await manage('GET', '')).json();
  for (const key of keys) await manage('DELETE', `/${key.id}`);
  assert.equal((await (await manage('GET', '')).json()).keys.length, 0);
});

const listAccounts = token => fetch(`${base}/api/integrations/v1/accounts`, { headers: { authorization: `Bearer ${token}` } });
const setScopes = (keyId, scopes) => manage('PATCH', `/${keyId}`, { scopes });

test('listing accounts needs the "Read accounts" permission, which a token does not get by default', async () => {
  const { token } = await create('no-accounts-yet', ['messages:send', 'messages:read']);
  const refused = await listAccounts(token);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).message, /permission/);
  assert.equal((await create('default-scopes')).key.scopes.includes('accounts:read'), false);
});

test('a token with "Read accounts" lists every account: id, name, number and status, sorted by name', async () => {
  provider.__test.seedAccount('zeta-account', { phone: '15550000002' });
  provider.__test.seedAccount('alpha-account', { phone: '15550000001' });
  const { token } = await create('picker', ['accounts:read']);
  const response = await listAccounts(token);
  assert.equal(response.status, 200);
  const { accounts } = await response.json();
  const ids = accounts.map(account => account.id);
  for (const id of [ACCOUNT, 'zeta-account', 'alpha-account']) assert.ok(ids.includes(id), id);
  for (const account of accounts) assert.deepEqual(Object.keys(account).sort(), ['current', 'id', 'label', 'phone', 'status']);
  const labels = accounts.map(account => String(account.label).toLowerCase());
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)), 'sorted by name for a dropdown');
  assert.deepEqual(accounts.filter(account => account.current).map(account => account.id), [ACCOUNT], 'only the token\'s own account is marked current');
});

test('the accounts list exposes nothing but id, name, number and status — no messages, jids, pictures or secrets', async () => {
  const { token } = await create('picker-private', ['accounts:read']);
  const text = await (await listAccounts(token)).text();
  assert.equal(/ownJid|picture|chats|message|hash|tokenEnc|last4|mentionNames/.test(text), false, text);
  assert.equal(text.includes(token), false);
});

test('"Read accounts" alone does not let a token send or read messages', async () => {
  const { token } = await create('picker-only', ['accounts:read']);
  assert.equal((await send(token, { phone: '18577075969', text: 'nope' })).status, 403);
  assert.equal((await fetch(`${base}/api/integrations/v1/chats`, { headers: { authorization: `Bearer ${token}` } })).status, 403);
});

test('the permission can be switched on and off for an existing token', async () => {
  const { key, token } = await create('toggle', ['messages:send']);
  assert.equal((await listAccounts(token)).status, 403);
  assert.equal((await setScopes(key.id, ['messages:send', 'accounts:read'])).status, 200);
  assert.equal((await listAccounts(token)).status, 200);
  assert.equal((await setScopes(key.id, ['messages:send'])).status, 200);
  assert.equal((await listAccounts(token)).status, 403);
});

test('the accounts list refuses a missing or wrong token', async () => {
  assert.equal((await listAccounts('wh_live_not-a-real-token')).status, 401);
  assert.equal((await fetch(`${base}/api/integrations/v1/accounts`)).status, 401);
});
