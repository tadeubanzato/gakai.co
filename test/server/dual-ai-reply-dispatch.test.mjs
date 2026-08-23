import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import http from 'node:http';

let llmHits = 0;
const mockLlmProxy = http.createServer((req, res) => {
  llmHits += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'mock reply' } }] }));
});
await new Promise(resolve => mockLlmProxy.listen(0, '127.0.0.1', resolve));
const mockLlmProxyPort = mockLlmProxy.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-dual-ai-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_WEBHOOK_SECRET = 'test-webhook-secret';

const { server, store } = await import('../../server.mjs');
after(() => { server.close(); mockLlmProxy.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

function llmConfigFor(accountId) {
  return { accountId, provider: 'omniroute', baseUrl: `http://127.0.0.1:${mockLlmProxyPort}`, apiKey: 'test-key', model: 'test-model', systemPrompt: '', nativeEnabled: true, configuredAt: new Date().toISOString() };
}

async function postWebhookEvent(accountId, messageId, payloadOverrides = {}) {
  const body = JSON.stringify({
    event: 'message', session: accountId,
    payload: { id: { _serialized: messageId }, from: '5511999999999@c.us', fromMe: false, body: 'hello', text: 'hello', timestamp: Math.floor(Date.now() / 1000), hasMedia: false, ...payloadOverrides },
  });
  const signature = createHmac('sha512', 'test-webhook-secret').update(body).digest('hex');
  const response = await fetch(`${base}/api/app/provider-events`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-hmac': signature }, body,
  });
  assert.equal(response.status, 202);
  // Dispatch runs fire-and-forget after the 202 response; give it a window to finish.
  await new Promise(resolve => setTimeout(resolve, 300));
}

test('native LLM reply fires when no agentic n8n automation is enabled for the account', async () => {
  const accountId = 'no-n8n-account';
  store.llmConfigs.push(llmConfigFor(accountId));

  const before = llmHits;
  await postWebhookEvent(accountId, 'msg-1');
  assert.equal(llmHits, before + 1, 'native LLM must be dispatched when nothing else is handling AI replies for this account');
});

test('native LLM reply is skipped when an enabled n8n AI Agent automation exists for the account', async () => {
  const accountId = 'has-n8n-account';
  store.llmConfigs.push(llmConfigFor(accountId));
  store.automationSubscriptions.push({
    id: 'agentic-sub', accountId, name: 'n8n auto-connect (AI Agent)',
    url: 'https://127.0.0.1:1/webhook/unused', productionUrl: 'https://127.0.0.1:1/webhook/unused', testUrl: null, testPhone: null,
    enabled: true, events: ['message.received'], secret: 'unused', createdAt: new Date().toISOString(), lastDelivery: null,
  });

  const before = llmHits;
  await postWebhookEvent(accountId, 'msg-2');
  assert.equal(llmHits, before, 'the n8n AI Agent must win: native LLM must not also reply');
});

// Also doubles as a regression check for event-id collisions: each test in
// this file posts a different structured message id (msg-1/msg-2/msg-3). If
// dispatchAutomationEvent ever again stringified the raw id object instead of
// resolving it via providerMessageId, every event would collide onto the same
// "evt_[object Object]" primary key and this test's dispatch would be
// silently deduped away — failing the assertion below, not just this guard.
test('a disabled n8n AI Agent automation does not suppress the native LLM reply', async () => {
  const accountId = 'disabled-n8n-account';
  store.llmConfigs.push(llmConfigFor(accountId));
  store.automationSubscriptions.push({
    id: 'agentic-sub-disabled', accountId, name: 'n8n auto-connect (AI Agent)',
    url: 'https://127.0.0.1:1/webhook/unused', productionUrl: 'https://127.0.0.1:1/webhook/unused', testUrl: null, testPhone: null,
    enabled: false, events: ['message.received'], secret: 'unused', createdAt: new Date().toISOString(), lastDelivery: null,
  });

  const before = llmHits;
  await postWebhookEvent(accountId, 'msg-3');
  assert.equal(llmHits, before + 1, 'only an enabled AI Agent automation should suppress native replies');
});

test('a "message" event with no body, text, or media is not dispatched to native AI reply', async () => {
  // Mirrors the inbox's ghost-timestamp finding (WAHA/WEBJS can touch a
  // chat/message with no real content behind it) — if that ever reaches the
  // webhook path, it must not trigger an AI reply either.
  const accountId = 'ghost-event-account';
  store.llmConfigs.push(llmConfigFor(accountId));

  const before = llmHits;
  await postWebhookEvent(accountId, 'msg-ghost', { body: '', text: '', hasMedia: false });
  assert.equal(llmHits, before, 'a contentless event must not trigger a native AI reply');
});
