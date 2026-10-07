import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { TEMPLATES } from '../../src/domain/voice-profile.mjs';

// A stand-in LLM that records the instructions it was given.
const seen = [];
const mockLlm = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try { seen.push(JSON.parse(body).messages); } catch { /* the connection check has no body worth keeping */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok reply' } }] }));
  });
});
await new Promise(resolve => mockLlm.listen(0, '127.0.0.1', resolve));
const llmPort = mockLlm.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-voices-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, store, provider, dispatchAutomationEvent, replyInstructions } = await import('../../server.mjs');
after(() => { server.close(); mockLlm.close(); });
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'voices-admin', password: 'a-long-enough-password' }) });
const cookie = setup.headers.get('set-cookie').split(';')[0];
const ACCOUNT = 'voices-account';
provider.__test.seedAccount(ACCOUNT, { ownJid: '18577075969:12@s.whatsapp.net' });

const url = (suffix = '', account = ACCOUNT) => `${base}/api/app/accounts/${account}/voices${suffix}`;
const call = (method, suffix, body, headers = { cookie }, account = ACCOUNT) => fetch(url(suffix, account), { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async () => (await (await call('GET', '')).json());
const MOM = TEMPLATES.find(template => template.id === 'family').yaml;
const FRIENDS = TEMPLATES.find(template => template.id === 'friends').yaml;
const yamlNamed = name => `name: ${name}\nvoice: warm\n`;

test('a new account has no voices, the 5-profile limit, and the templates to start from', async () => {
  const body = await list();
  assert.deepEqual(body.voices, []);
  assert.equal(body.limit, 5);
  assert.ok(body.templates.length >= 3);
  assert.ok(body.templates.every(template => template.id && template.label && template.yaml));
});

test('voice profiles are for the signed-in administrator only', async () => {
  assert.equal((await call('GET', '', undefined, {})).status, 401);
  assert.equal((await call('POST', '', { yaml: MOM }, {})).status, 401);
});

test('validating shows a preview of what the AI will be told, or the problems with their lines', async () => {
  const good = await (await call('POST', '/validate', { yaml: MOM })).json();
  assert.equal(good.ok, true);
  assert.equal(good.name, 'Mom');
  assert.match(good.preview.direct, /Who you are talking to: My mother/);
  assert.match(good.preview.group, /replying because the owner was tagged/);

  const bad = await (await call('POST', '/validate', { yaml: 'name: Mom\nnevr:\n  - x\n' })).json();
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /Did you mean "never"/);
  assert.equal(bad.errors[0].line, 2);
});

test('creating, editing and deleting a voice', async () => {
  const created = await call('POST', '', { yaml: MOM });
  assert.equal(created.status, 201);
  const { voice } = await created.json();
  assert.equal(voice.name, 'Mom');
  assert.match(voice.id, /^vo_[0-9a-f]+$/);
  assert.deepEqual((await list()).voices.map(item => item.name), ['Mom']);

  const edited = await call('PUT', `/${voice.id}`, { yaml: MOM.replace('name: Mom', 'name: Mãe') });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).voice.name, 'Mãe');
  assert.equal((await list()).voices[0].id, voice.id, 'editing keeps the same voice');

  assert.equal((await call('DELETE', `/${voice.id}`)).status, 200);
  assert.deepEqual((await list()).voices, []);
  assert.equal((await call('DELETE', '/vo_missing')).status, 404);
  assert.equal((await call('PUT', '/vo_missing', { yaml: MOM })).status, 404);
});

test('a profile with problems is refused, with the problems listed, and a name can only be used once', async () => {
  const refused = await call('POST', '', { yaml: 'voice: warm' });
  assert.equal(refused.status, 400);
  const body = await refused.json();
  assert.match(body.errors[0].message, /"name" is required/);

  assert.equal((await call('POST', '', { yaml: yamlNamed('Twin') })).status, 201);
  const clash = await call('POST', '', { yaml: yamlNamed('twin') });
  assert.equal(clash.status, 409, 'names are compared ignoring case');
  assert.match((await clash.json()).message, /already have a voice called "twin"/);
  const twin = (await list()).voices.find(item => item.name === 'Twin');
  assert.equal((await call('PUT', `/${twin.id}`, { yaml: yamlNamed('Twin') + 'emoji: none\n' })).status, 200, 'saving a voice under its own name is fine');
  await call('DELETE', `/${twin.id}`);
});

test('an account can have at most 5 voices, and another account does not see them', async () => {
  for (let index = 1; index <= 5; index += 1) assert.equal((await call('POST', '', { yaml: yamlNamed(`Voice ${index}`) })).status, 201, `voice ${index}`);
  const over = await call('POST', '', { yaml: yamlNamed('Voice 6') });
  assert.equal(over.status, 409);
  assert.match((await over.json()).message, /up to 5/);
  provider.__test.seedAccount('voices-other');
  assert.deepEqual((await (await call('GET', '', undefined, { cookie }, 'voices-other')).json()).voices, []);
  const ids = (await list()).voices.map(item => item.id);
  assert.equal((await call('PUT', `/${ids[0]}`, { yaml: yamlNamed('Hijack') }, { cookie }, 'voices-other')).status, 404, 'another account cannot edit it');
  for (const id of ids) await call('DELETE', `/${id}`);
});

// ---- choosing a voice for people and groups, and what the model is told -----------------

const GROUP = '120363025246125486@g.us';
async function enableAi(rules) {
  store.llmConfigs = store.llmConfigs.filter(item => item.accountId !== ACCOUNT);
  store.llmConfigs.push({ accountId: ACCOUNT, provider: 'omniroute', baseUrl: `http://127.0.0.1:${llmPort}`, apiKey: 'k', model: 'm', systemPrompt: '', nativeEnabled: true, replyRules: rules, configuredAt: new Date().toISOString() });
}
const putRules = body => fetch(`${base}/api/app/accounts/${ACCOUNT}/llm/rules`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const incoming = async (chatId, extra = {}) => {
  const before = seen.length;
  await dispatchAutomationEvent({ accountId: ACCOUNT, chatId, message: { id: Math.random().toString(36), body: 'hello', text: 'hello', hasMedia: false, sender: null, mentionedJids: [], ...extra } });
  return seen.slice(before)[0]?.[0]?.content ?? null;   // the system message the model received
};

test('each person and group is answered in the voice chosen for them, and everyone else in the built-in basic style', async () => {
  const mom = (await (await call('POST', '', { yaml: MOM })).json()).voice;
  const friends = (await (await call('POST', '', { yaml: FRIENDS })).json()).voice;
  await enableAi({ numbers: ['18577075969', '5511999777057', '15551230000'], groups: [GROUP] });
  const saved = await (await putRules({ numbers: ['18577075969', '5511999777057', '15551230000'], groups: [GROUP], assignments: { '18577075969': mom.id, '5511999777057': friends.id, [GROUP]: mom.id } })).json();
  assert.equal(saved.replyRules.assignments['18577075969'], mom.id);

  const toMom = await incoming('18577075969@s.whatsapp.net');
  assert.match(toMom, /Who you are talking to: My mother/);
  assert.match(toMom, /Never:\n- promise visits, calls or plans/);
  const toFriend = await incoming('5511999777057@s.whatsapp.net');
  assert.match(toFriend, /Close friends/);
  assert.equal(toFriend.includes('My mother'), false, 'a friend never gets the mom voice');
  const toStranger = await incoming('15551230000@s.whatsapp.net');
  assert.match(toStranger, /WhatsApp assistant/, 'no voice chosen: the built-in basic style');
  const inGroup = await incoming(GROUP, { mentionedJids: ['18577075969@s.whatsapp.net'] });
  assert.match(inGroup, /replying because the owner was tagged/);
  assert.match(inGroup, /Who you are talking to: My mother/);
});

test('a voice that does not exist is never saved as a choice, and deleting a voice releases the people using it', async () => {
  const voice = (await (await call('POST', '', { yaml: yamlNamed('Temp') })).json()).voice;
  await enableAi({ numbers: ['18577075969'], groups: [] });
  const body = await (await putRules({ numbers: ['18577075969'], groups: [], assignments: { '18577075969': 'vo_does_not_exist' } })).json();
  assert.equal('assignments' in body.replyRules, false, 'an unknown voice id is dropped');

  await putRules({ numbers: ['18577075969'], groups: [], assignments: { '18577075969': voice.id } });
  assert.equal((await incoming('18577075969@s.whatsapp.net')).includes('Voice: warm'), true);
  await call('DELETE', `/${voice.id}`);
  assert.equal('assignments' in store.llmConfigs.find(item => item.accountId === ACCOUNT).replyRules, false, 'the choice is released');
  assert.match(await incoming('18577075969@s.whatsapp.net'), /WhatsApp assistant/, 'back to the built-in basic style');
});

test('deleting an account removes its voices', async () => {
  const gone = 'voices-doomed';
  provider.__test.seedAccount(gone);
  await call('POST', '', { yaml: yamlNamed('Doomed') }, { cookie }, gone);
  assert.equal(store.voiceProfiles.some(item => item.accountId === gone), true);
  await fetch(`${base}/api/app/accounts/${gone}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(store.voiceProfiles.some(item => item.accountId === gone), false);
});

const clearVoices = async () => { for (const voice of (await list()).voices) await call('DELETE', `/${voice.id}`); };

test('the instructions for a conversation are its voice, and the built-in basic style only when none is chosen', async () => {
  await clearVoices();
  const mom = (await (await call('POST', '', { yaml: MOM })).json()).voice;
  await enableAi({ numbers: ['18577075969', '15551230000'], groups: [GROUP] });
  await putRules({ numbers: ['18577075969', '15551230000'], groups: [GROUP], assignments: { '18577075969': mom.id, [GROUP]: mom.id } });
  const event = (chatId, extra = {}) => ({ chat: { id: chatId, kind: chatId.endsWith('@g.us') ? 'group' : 'direct', ...extra } });

  assert.match(await replyInstructions(ACCOUNT, event('18577075969@s.whatsapp.net')), /Who you are talking to: My mother/);
  assert.match(await replyInstructions(ACCOUNT, event(GROUP)), /replying because the owner was tagged/);
  assert.match(await replyInstructions(ACCOUNT, event('15551230000@s.whatsapp.net')), /WhatsApp assistant/, 'nobody chose a voice for them: the built-in basic style');
  await call('DELETE', `/${mom.id}`);
});

test('the settings test message uses the voice chosen for the number it is sent to', async () => {
  await clearVoices();
  const mom = (await (await call('POST', '', { yaml: MOM })).json()).voice;
  await enableAi({ numbers: ['18577075969'], groups: [] });
  await putRules({ numbers: ['18577075969'], groups: [], assignments: { '18577075969': mom.id } });
  const test = phone => fetch(`${base}/api/app/accounts/${ACCOUNT}/llm/test`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ prompt: 'hi', phone }) });
  let before = seen.length;
  assert.equal((await test('+1 857 707 5969')).status, 200);
  assert.match(seen.slice(before)[0][0].content, /Who you are talking to: My mother/);
  before = seen.length;
  assert.equal((await test('')).status, 200);
  assert.match(seen.slice(before)[0][0].content, /WhatsApp assistant/, 'no number: the built-in basic style');
  await call('DELETE', `/${mom.id}`);
});

test('the AI is told who it is replying to, and sees the recent conversation, with every reply', async () => {
  await clearVoices();
  const chat = '5511977776666@s.whatsapp.net';   // its own chat: earlier tests' AI replies are stored in the others
  await enableAi({ numbers: ['5511977776666'], groups: [] });
  const now = Math.floor(Date.now() / 1000);
  provider.__test.seedMessage(ACCOUNT, chat, { id: 'h1', timestamp: now - 300, fromMe: false, body: 'Já almoçou?', text: 'Já almoçou?', hasMedia: false });
  provider.__test.seedMessage(ACCOUNT, chat, { id: 'h2', timestamp: now - 200, fromMe: true, body: 'Já sim! E você?', text: 'Já sim! E você?', hasMedia: false });
  const before = seen.length;
  await dispatchAutomationEvent({ accountId: ACCOUNT, chatId: chat, message: { id: 'h3', timestamp: now, fromMe: false, body: 'Também. Vai vir domingo?', text: 'Também. Vai vir domingo?', hasMedia: false, sender: { id: chat, name: 'Mom' }, mentionedJids: [] } });
  const sent = seen.slice(before)[0];
  assert.equal(sent[0].role, 'system');
  assert.match(sent[0].content, /You are replying to: Mom \(\+5511977776666\)\./);
  assert.match(sent[0].content, /recent conversation, oldest first/);
  assert.deepEqual(sent.slice(1), [
    { role: 'user', content: 'Já almoçou?' },
    { role: 'assistant', content: 'Já sim! E você?' },
    { role: 'user', content: 'Também. Vai vir domingo?' },
  ]);
});

test('a photo or voice note with no caption gets no AI reply, because the AI cannot see or hear it', async () => {
  await enableAi({ numbers: ['5511977776666'], groups: [] });
  const before = seen.length;
  await dispatchAutomationEvent({ accountId: ACCOUNT, chatId: '5511977776666@s.whatsapp.net', message: { id: 'media-only', timestamp: Math.floor(Date.now() / 1000), fromMe: false, body: '', text: '', hasMedia: true, media: { mimetype: 'image/jpeg' }, sender: null, mentionedJids: [] } });
  assert.equal(seen.length, before, 'no request reached the AI');
});
