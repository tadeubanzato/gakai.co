import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// The "Send test message" button on the LLM Proxy panel used to only ever
// call the proxy and show the reply — it never delivered anything to
// WhatsApp, unlike the n8n test button, which round-trips through the real
// WhatsApp-sending pipeline. This exercises the fix: /llm/test now takes an
// optional phone number and, when given, actually sends the proxy's reply
// via the same providerRequest('/api/sendText') call the real native-reply
// dispatch path (dispatchLLMReply) makes.
const mockLlmProxy = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'mock proxy reply' } }] }));
});
await new Promise(resolve => mockLlmProxy.listen(0, '127.0.0.1', resolve));
const mockLlmProxyPort = mockLlmProxy.address().port;

let sendTextCalls = [];
const mockProvider = http.createServer((req, res) => {
  if (req.url === '/api/sendText') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      sendTextCalls.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockProviderPort = mockProvider.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-llm-test-delivery-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;

const { server, store } = await import('../../server.mjs');
after(() => { server.close(); mockLlmProxy.close(); mockProvider.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'llm-test-delivery-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

function seedLlmConfig(accountId) {
  store.llmConfigs.push({
    accountId, provider: 'omniroute', baseUrl: `http://127.0.0.1:${mockLlmProxyPort}`, apiKey: 'test-key', model: 'test-model',
    systemPrompt: '', nativeEnabled: false, configuredAt: new Date().toISOString(),
  });
}

test('/llm/test with no phone number only checks the proxy — nothing is sent to WhatsApp', async () => {
  const accountId = 'llm-test-no-phone';
  seedLlmConfig(accountId);
  sendTextCalls = [];

  const response = await fetch(`${base}/api/app/accounts/${accountId}/llm/test`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'hello' }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.reply, 'mock proxy reply');
  assert.equal(body.delivered, false);
  assert.equal(sendTextCalls.length, 0, 'no phone number was given, so nothing should be sent to WhatsApp');
});

test('/llm/test with a phone number delivers the proxy\'s reply to WhatsApp, the same way a real native reply would', async () => {
  const accountId = 'llm-test-with-phone';
  seedLlmConfig(accountId);
  sendTextCalls = [];

  const response = await fetch(`${base}/api/app/accounts/${accountId}/llm/test`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'hello', phone: '5511999999999' }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.reply, 'mock proxy reply');
  assert.equal(body.delivered, true);
  assert.equal(sendTextCalls.length, 1);
  assert.equal(sendTextCalls[0].session, accountId);
  assert.equal(sendTextCalls[0].chatId, '5511999999999@c.us');
  assert.equal(sendTextCalls[0].text, 'mock proxy reply');
});

test('/llm/test rejects a malformed phone number before ever calling the proxy', async () => {
  const accountId = 'llm-test-bad-phone';
  seedLlmConfig(accountId);
  sendTextCalls = [];

  const response = await fetch(`${base}/api/app/accounts/${accountId}/llm/test`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'hello', phone: '1'.repeat(31) }),
  });

  assert.equal(response.status, 400);
  assert.equal(sendTextCalls.length, 0);
});
