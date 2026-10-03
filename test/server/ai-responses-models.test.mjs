import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// A stand-in LiteLLM proxy: lists two models, answers chat completions, and
// records the bearer token each request carried.
const seenAuth = [];
const mockProxy = http.createServer((req, res) => {
  seenAuth.push(req.headers.authorization);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.url.endsWith('/models') ? JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'claude-sonnet' }] }) : JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
});
await new Promise(resolve => mockProxy.listen(0, '127.0.0.1', resolve));
const proxyUrl = `http://127.0.0.1:${mockProxy.address().port}/v1`;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-ai-models-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server, store } = await import('../../server.mjs');
after(() => { server.close(); mockProxy.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'models-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];
const post = (path, body) => fetch(`${base}/api/app/accounts/models-account${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
});

test('POST /llm/models lists the models the LiteLLM proxy reports for the typed key', async () => {
  const response = await post('/llm/models', { provider: 'litellm', baseUrl: proxyUrl, apiKey: 'sk-typed' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).models, ['claude-sonnet', 'gpt-4o']);
  assert.equal(seenAuth.at(-1), 'Bearer sk-typed');
});

test('POST /llm/models with "__keep__" and nothing saved asks for a key instead of calling out', async () => {
  const before = seenAuth.length;
  const response = await post('/llm/models', { provider: 'litellm', baseUrl: proxyUrl, apiKey: '__keep__' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /API key/i);
  assert.equal(seenAuth.length, before, 'no request may reach the proxy');
});

test('saving records the provider, and the saved key is reused only for the same provider and URL', async () => {
  const save = await post('/llm', { provider: 'litellm', baseUrl: proxyUrl, apiKey: 'sk-saved', model: 'gpt-4o', systemPrompt: '' });
  assert.equal(save.status, 200);
  assert.equal(store.llmConfigs.find(item => item.accountId === 'models-account').provider, 'litellm');

  const sameTarget = await post('/llm/models', { provider: 'litellm', baseUrl: proxyUrl, apiKey: '__keep__' });
  assert.equal(sameTarget.status, 200);
  assert.equal(seenAuth.at(-1), 'Bearer sk-saved');

  // A different URL must never receive the stored key.
  const before = seenAuth.length;
  const otherUrl = await post('/llm/models', { provider: 'litellm', baseUrl: proxyUrl.replace('/v1', '/other/v1'), apiKey: '__keep__' });
  assert.equal(otherUrl.status, 400);
  assert.equal(seenAuth.length, before, 'the saved key must not be sent to a different URL');

  // Neither may a different provider reuse it, on list or on save.
  assert.equal((await post('/llm/models', { provider: 'claude', apiKey: '__keep__' })).status, 400);
  const switched = await post('/llm', { provider: 'chatgpt', apiKey: '__keep__', model: 'gpt-4o' });
  assert.equal(switched.status, 400);
  assert.match((await switched.json()).message, /API key for this provider/i);
});

test('saving requires a chosen model', async () => {
  const response = await post('/llm', { provider: 'litellm', baseUrl: proxyUrl, apiKey: 'sk-new', model: '' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /model/i);
});

test('GET /llm reports the saved provider', async () => {
  const response = await fetch(`${base}/api/app/accounts/models-account/llm`, { headers: { cookie } });
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.equal(body.provider, 'litellm');
});
