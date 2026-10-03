import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

let llmHits = 0;
const mockLlmProxy = http.createServer((req, res) => {
  llmHits += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'mock reply' } }] }));
});
await new Promise(resolve => mockLlmProxy.listen(0, '127.0.0.1', resolve));
const proxyPort = mockLlmProxy.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-reply-rules-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, store, provider, dispatchAutomationEvent } = await import('../../server.mjs');
after(() => { server.close(); mockLlmProxy.close(); });
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'rules-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];
const GROUP = '120363025246125486@g.us';

function enableAi(accountId, replyRules) {
  provider.__test.seedAccount(accountId, { ownJid: '18577075969:12@s.whatsapp.net', ownLid: '2000111222333:12@lid' });
  store.llmConfigs.push({ accountId, provider: 'omniroute', baseUrl: `http://127.0.0.1:${proxyPort}`, apiKey: 'k', model: 'm', systemPrompt: '', nativeEnabled: true, replyRules, configuredAt: new Date().toISOString() });
}
async function dispatch(accountId, { chatId, mentionedJids = [], id = Math.random().toString(36) }) {
  const before = llmHits;
  await dispatchAutomationEvent({ accountId, chatId, message: { id, body: 'hello', text: 'hello', hasMedia: false, sender: null, mentionedJids } });
  return llmHits - before;
}

test('an account with no reply rules answers nobody, even with native AI enabled', async () => {
  enableAi('no-rules', undefined);
  assert.equal(await dispatch('no-rules', { chatId: '18577075969@s.whatsapp.net' }), 0);
  assert.equal(await dispatch('no-rules', { chatId: GROUP, mentionedJids: ['18577075969@s.whatsapp.net'] }), 0);
});

test('a direct message is answered only from a listed number', async () => {
  enableAi('direct', { numbers: ['+1 857 707 5969'], groups: [] });
  assert.equal(await dispatch('direct', { chatId: '18577075969@s.whatsapp.net' }), 1);
  assert.equal(await dispatch('direct', { chatId: '5511999999999@s.whatsapp.net' }), 0);
});

test('a listed group is answered only when the account is tagged, by phone number or by LID', async () => {
  enableAi('group', { numbers: [], groups: [GROUP] });
  assert.equal(await dispatch('group', { chatId: GROUP }), 0, 'no tag, no reply');
  assert.equal(await dispatch('group', { chatId: GROUP, mentionedJids: ['5511000000000@s.whatsapp.net'] }), 0, 'someone else tagged');
  assert.equal(await dispatch('group', { chatId: GROUP, mentionedJids: ['18577075969@s.whatsapp.net'] }), 1, 'tagged by phone number');
  assert.equal(await dispatch('group', { chatId: GROUP, mentionedJids: ['2000111222333@lid'] }), 1, 'tagged by LID');
  assert.equal(await dispatch('group', { chatId: '999@g.us', mentionedJids: ['18577075969@s.whatsapp.net'] }), 0, 'unlisted group');
});

test('PUT /llm/rules normalizes and persists the list, and GET /llm returns it', async () => {
  const accountId = 'rules-route';
  store.llmConfigs.push({ accountId, provider: 'litellm', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', systemPrompt: '', nativeEnabled: false, configuredAt: new Date().toISOString() });
  const put = await fetch(`${base}/api/app/accounts/${accountId}/llm/rules`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ numbers: '+1 (857) 707-5969\nnot a number', groups: ['120363025246125486', 'bad'] }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).replyRules, { numbers: ['18577075969'], groups: [GROUP] });
  const get = await (await fetch(`${base}/api/app/accounts/${accountId}/llm`, { headers: { cookie } })).json();
  assert.deepEqual(get.replyRules, { numbers: ['18577075969'], groups: [GROUP] });
});

test('PUT /llm/rules refuses when AI Responses has not been set up', async () => {
  const put = await fetch(`${base}/api/app/accounts/never-configured/llm/rules`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ numbers: ['18577075969'] }),
  });
  assert.equal(put.status, 404);
});

test('GET /reply-targets searches people by name or digits and groups by name, from the account chats', async () => {
  const accountId = 'targets-account';
  provider.__test.seedAccount(accountId);
  provider.__test.seedChat(accountId, { id: '5511999777057@s.whatsapp.net', name: null, unreadCount: 0, lastMessageTimestamp: 300 });
  provider.__test.seedChat(accountId, { id: '120363025246125486@g.us', name: 'Família Banzato', unreadCount: 0, lastMessageTimestamp: 200 });
  provider.__test.seedContact(accountId, { id: '5511999777057@s.whatsapp.net', name: 'Marina Souza', phone: '5511999777057' });
  const get = async query => (await (await fetch(`${base}/api/app/accounts/${accountId}/reply-targets?${query}`, { headers: { cookie } })).json()).results;

  assert.deepEqual((await get('kind=person&q=marina')).map(r => r.value), ['5511999777057']);
  assert.deepEqual((await get('kind=person&q=11999777')).map(r => r.label), ['Marina Souza']);
  assert.deepEqual(await get('kind=person&q=marina&exclude=5511999777057'), []);
  assert.deepEqual((await get('kind=group&q=familia')).map(r => r.label), ['Família Banzato']);
  assert.deepEqual((await get('kind=group&q=marina')), [], 'a person is never suggested as a group');
});

test('saved rules come back with display names for their tags', async () => {
  const accountId = 'targets-account';
  store.llmConfigs.push({ accountId, provider: 'litellm', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', systemPrompt: '', nativeEnabled: false, configuredAt: new Date().toISOString() });
  const put = await fetch(`${base}/api/app/accounts/${accountId}/llm/rules`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ numbers: ['5511999777057', '442079460958'], groups: ['120363025246125486@g.us'] }),
  });
  const body = await put.json();
  assert.deepEqual(body.replyLabels, { numbers: { 5511999777057: 'Marina Souza', 442079460958: null }, groups: { '120363025246125486@g.us': 'Família Banzato' } });
  const get = await (await fetch(`${base}/api/app/accounts/${accountId}/llm`, { headers: { cookie } })).json();
  assert.deepEqual(get.replyLabels, body.replyLabels);
});

test('POST /chats/:id/ai puts a conversation on the AI reply list, and the chat overview reports it', async () => {
  const accountId = 'chat-ai-toggle';
  provider.__test.seedAccount(accountId);
  const now = Math.floor(Date.now() / 1000); // recent enough for the inbox list
  provider.__test.seedChat(accountId, { id: '5511999777057@s.whatsapp.net', name: 'Marina', unreadCount: 0, lastMessageTimestamp: now, lastMessage: { body: 'oi', text: 'oi', timestamp: now } });
  provider.__test.seedChat(accountId, { id: '120363025246125486@g.us', name: 'Família', unreadCount: 0, lastMessageTimestamp: now - 10, lastMessage: { body: 'oi', text: 'oi', timestamp: now - 10 } });
  const call = (chatId, enabled) => fetch(`${base}/api/app/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/ai`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ enabled }),
  });

  assert.equal((await call('5511999777057@s.whatsapp.net', true)).status, 409, 'AI Responses is not set up yet');

  store.llmConfigs.push({ accountId, provider: 'litellm', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', systemPrompt: '', nativeEnabled: true, configuredAt: new Date().toISOString() });
  const on = await (await call('5511999777057@s.whatsapp.net', true)).json();
  assert.equal(on.chat.aiReply, true);
  assert.equal(on.chat.aiActive, true);
  assert.deepEqual(store.llmConfigs.find(item => item.accountId === accountId).replyRules.numbers, ['5511999777057']);

  assert.equal((await (await call('120363025246125486@g.us', true)).json()).chat.aiReply, true);
  const list = await (await fetch(`${base}/api/app/accounts/${accountId}/chats`, { headers: { cookie } })).json();
  assert.deepEqual(Object.fromEntries(list.map(chat => [chat.id, chat.aiReply])), { '5511999777057@s.whatsapp.net': true, '120363025246125486@g.us': true });

  assert.equal((await (await call('5511999777057@s.whatsapp.net', false)).json()).chat.aiReply, false);
  assert.deepEqual(store.llmConfigs.find(item => item.accountId === accountId).replyRules.numbers, []);

  store.llmConfigs.find(item => item.accountId === accountId).nativeEnabled = false;
  const paused = await (await call('5511999777057@s.whatsapp.net', true)).json();
  assert.equal(paused.chat.aiReply, true);
  assert.equal(paused.chat.aiActive, false, 'listed, but AI replies are switched off');
});
