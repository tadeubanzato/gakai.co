import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { URL as NodeURL } from 'node:url';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';

// Mirrors server.mjs's encryptSecret exactly (same key derivation, same
// aes-256-gcm scheme) so this test can seed a connection with a
// n8nApiKeyEncrypted value the real decryptSecret() can actually open —
// without exporting that internal function from server.mjs just for tests.
const stateSecretKey = createHash('sha256').update(process.env.GAKAI_STATE_SECRET || process.env.GAKAI_PROVIDER_WEBHOOK_SECRET || 'gakai-dev-secret').digest();
function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', stateSecretKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

// A minimal but functionally real n8n API mock: enough for
// syncAgenticN8nInstructions' fetch+patch+PUT cycle and the credential
// sync, backing an already-existing AI Agent workflow (the "enable an
// existing workflow" path — the new behavior under test here).
let storedWorkflow;
function resetWorkflow() {
  storedWorkflow = {
    id: 'wf-agentic-1',
    name: 'Gakai – Test Account (AI Agent)',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [250, 300], parameters: { httpMethod: 'POST', path: 'gakai-test-account-ai', authentication: 'headerAuth', responseMode: 'responseNode', options: {} }, credentials: { httpHeaderAuth: { id: 'cred-inbound', name: 'Gakai Inbound Secret' } } },
      { id: 'n2', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: [625, 300], parameters: { promptType: 'define', text: '={{ dummy }}', options: { systemMessage: 'old prompt' } } },
      { id: 'n3', name: 'OpenAI Chat Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.3, position: [625, 500], parameters: { model: { __rl: true, mode: 'list', value: 'old-model' }, options: {} }, credentials: { openAiApi: { id: 'cred-llm', name: 'Gakai LLM Proxy' } } },
      { id: 'n4', name: 'Respond to Webhook', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, position: [1000, 300], parameters: { respondWith: 'json', responseBody: "={{ { reply: $json.output } }}" } },
    ],
    connections: {},
  };
}
resetWorkflow();

const mockN8n = http.createServer((req, res) => {
  const url = new NodeURL(req.url, 'http://mock-n8n');
  const respond = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.method === 'GET' && url.pathname === '/api/v1/workflows') return respond(200, { data: [] });
    if (req.method === 'GET' && url.pathname === `/api/v1/workflows/${storedWorkflow.id}`) return respond(200, storedWorkflow);
    if (req.method === 'PUT' && url.pathname === `/api/v1/workflows/${storedWorkflow.id}`) { const patch = JSON.parse(body); storedWorkflow = { ...storedWorkflow, ...patch }; return respond(200, storedWorkflow); }
    if (req.method === 'POST' && url.pathname === `/api/v1/workflows/${storedWorkflow.id}/activate`) return respond(200, {});
    if (req.method === 'PUT' && url.pathname === '/api/v1/credentials/cred-llm') return respond(200, { id: 'cred-llm', name: 'Gakai LLM Proxy' });
    return respond(404, { message: 'not found in mock' });
  });
});
await new Promise(resolve => mockN8n.listen(0, '127.0.0.1', resolve));
const mockN8nUrl = `http://127.0.0.1:${mockN8n.address().port}`;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-n8n-agent-toggle-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server, store } = await import('../../server.mjs');
after(() => { server.close(); mockN8n.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'agent-toggle-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

function seedAccount(accountId, { nativeEnabled, agenticEnabled, standardEnabled }) {
  resetWorkflow();
  store.llmConfigs.push({ accountId, provider: 'omniroute', baseUrl: 'https://proxy.example/v1', apiKey: 'test-key', model: 'test-model', systemPrompt: '', nativeEnabled, configuredAt: new Date().toISOString() });
  store.n8nConnections.push({ accountId, kind: 'agentic', n8nUrl: mockN8nUrl, n8nApiKeyEncrypted: encryptSecret('mock-n8n-api-key'), workflowId: storedWorkflow.id, workflowName: storedWorkflow.name, webhookUrl: `${mockN8nUrl}/webhook/gakai-test-account-ai`, inboundCredentialId: 'cred-inbound', llmCredentialId: 'cred-llm', inboundSecret: 'secret', connectedAt: new Date().toISOString() });
  store.automationSubscriptions.push({ id: `sub-${accountId}`, accountId, name: 'n8n auto-connect (AI Agent)', url: `${mockN8nUrl}/webhook/gakai-test-account-ai`, productionUrl: `${mockN8nUrl}/webhook/gakai-test-account-ai`, testUrl: null, testPhone: null, enabled: agenticEnabled, events: ['message.received'], secret: 'secret', createdAt: new Date().toISOString(), lastDelivery: null });
  if (standardEnabled !== undefined) {
    store.automationSubscriptions.push({ id: `sub-standard-${accountId}`, accountId, name: 'n8n auto-connect', url: `${mockN8nUrl}/webhook/gakai-test-account`, productionUrl: `${mockN8nUrl}/webhook/gakai-test-account`, testUrl: null, testPhone: null, enabled: standardEnabled, events: ['message.received'], secret: 'secret', createdAt: new Date().toISOString(), lastDelivery: null });
  }
}

test('POST /n8n/connect/ai on an already-connected agentic workflow re-enables it, syncs it, and turns native replies off', async () => {
  const accountId = 'agent-toggle-existing';
  seedAccount(accountId, { nativeEnabled: true, agenticEnabled: false });

  const response = await fetch(`${base}/api/app/accounts/${accountId}/n8n/connect/ai`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(body.ok, true);
  const subscription = store.automationSubscriptions.find(s => s.accountId === accountId);
  assert.equal(subscription.enabled, true, 'the AI Agent subscription must be enabled after this route succeeds');
  const config = store.llmConfigs.find(c => c.accountId === accountId);
  assert.equal(config.nativeEnabled, false, 'native replies must be turned off when n8n AI Agent replies are enabled');
  // syncAgenticN8nInstructions must have actually run against the mock,
  // replacing the stale prompt/model that were seeded on the workflow.
  const agent = storedWorkflow.nodes.find(n => n.name === 'AI Agent');
  assert.notEqual(agent.parameters.options.systemMessage, 'old prompt');
});

test('PATCH /llm/native turns off an enabled n8n AI Agent subscription when enabling native replies', async () => {
  const accountId = 'agent-toggle-native-wins';
  seedAccount(accountId, { nativeEnabled: false, agenticEnabled: true });

  const response = await fetch(`${base}/api/app/accounts/${accountId}/llm/native`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ nativeEnabled: true }),
  });
  assert.equal(response.status, 200);
  const config = store.llmConfigs.find(c => c.accountId === accountId);
  assert.equal(config.nativeEnabled, true);
  const subscription = store.automationSubscriptions.find(s => s.accountId === accountId);
  assert.equal(subscription.enabled, false, 'the AI Agent subscription must be disabled once native replies are turned on');
});

test('saving the LLM proxy form (baseUrl/model/instructions) never resets nativeEnabled — it is managed only by PATCH /llm/native', async () => {
  const accountId = 'agent-toggle-save-preserves-native';
  seedAccount(accountId, { nativeEnabled: true, agenticEnabled: false });

  const response = await fetch(`${base}/api/app/accounts/${accountId}/llm`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ baseUrl: 'https://proxy.example/v1', apiKey: '__keep__', model: 'test-model', systemPrompt: 'updated instructions' }),
  });
  assert.equal(response.status, 200);
  const config = store.llmConfigs.find(c => c.accountId === accountId);
  assert.equal(config.nativeEnabled, true, 'the full-form save must not silently turn nativeEnabled off just because the field is absent from this request');
  assert.equal(config.systemPrompt, 'updated instructions');
});

// The plain "standard" n8n automation (its default Set node just echoes the
// inbound message back, but the workflow is the user's own to customize in
// n8n) is a deliberately separate concept from native/agentic AI replies —
// it must never be part of that mutual-exclusivity dance in either
// direction. Only native and agentic are two faces of the same "Gakai
// answers using the LLM proxy" toggle and stay exclusive of each other.
test('PATCH /automations/:id enabling the standard n8n subscription leaves an enabled AI Agent subscription and native replies untouched', async () => {
  const accountId = 'agent-toggle-standard-independent';
  seedAccount(accountId, { nativeEnabled: true, agenticEnabled: true, standardEnabled: false });
  const standardSub = store.automationSubscriptions.find(s => s.accountId === accountId && s.name === 'n8n auto-connect');

  const response = await fetch(`${base}/api/app/accounts/${accountId}/automations/${standardSub.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(response.status, 200);

  assert.equal(store.automationSubscriptions.find(s => s.id === standardSub.id).enabled, true);
  const agenticSub = store.automationSubscriptions.find(s => s.accountId === accountId && s.name === 'n8n auto-connect (AI Agent)');
  assert.equal(agenticSub.enabled, true, 'enabling the standard n8n subscription must not disable the AI Agent subscription');
  const config = store.llmConfigs.find(c => c.accountId === accountId);
  assert.equal(config.nativeEnabled, true, 'enabling the standard n8n subscription must not disable native replies');
});

test('POST /n8n/connect/ai leaves an enabled standard n8n subscription untouched when enabling AI Agent replies', async () => {
  const accountId = 'agent-toggle-agentic-independent';
  seedAccount(accountId, { nativeEnabled: false, agenticEnabled: false, standardEnabled: true });

  const response = await fetch(`${base}/api/app/accounts/${accountId}/n8n/connect/ai`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  assert.equal(response.status, 200);

  const standardSub = store.automationSubscriptions.find(s => s.accountId === accountId && s.name === 'n8n auto-connect');
  assert.equal(standardSub.enabled, true, 'the standard n8n subscription must stay enabled — it is independent of AI Agent replies');
});

test('PATCH /llm/native leaves an enabled standard n8n subscription untouched when enabling native replies', async () => {
  const accountId = 'agent-toggle-native-independent';
  seedAccount(accountId, { nativeEnabled: false, agenticEnabled: false, standardEnabled: true });

  const response = await fetch(`${base}/api/app/accounts/${accountId}/llm/native`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ nativeEnabled: true }),
  });
  assert.equal(response.status, 200);

  const standardSub = store.automationSubscriptions.find(s => s.accountId === accountId && s.name === 'n8n auto-connect');
  assert.equal(standardSub.enabled, true, 'the standard n8n subscription must stay enabled — it is independent of native replies');
});

test('PATCH /automations/:id enabling a hand-authored automation does not disturb any AI reply path', async () => {
  const accountId = 'agent-toggle-hand-authored-unaffected';
  seedAccount(accountId, { nativeEnabled: true, agenticEnabled: false, standardEnabled: false });
  store.automationSubscriptions.push({ id: `sub-custom-${accountId}`, accountId, name: 'My custom automation', url: `${mockN8nUrl}/webhook/custom`, productionUrl: `${mockN8nUrl}/webhook/custom`, testUrl: null, testPhone: null, enabled: false, events: ['message.received'], secret: 'secret', createdAt: new Date().toISOString(), lastDelivery: null });

  const response = await fetch(`${base}/api/app/accounts/${accountId}/automations/sub-custom-${accountId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(response.status, 200);

  const config = store.llmConfigs.find(c => c.accountId === accountId);
  assert.equal(config.nativeEnabled, true, 'a hand-authored automation is not a reply path and must not turn native replies off');
});

test('POST /n8n/connect/ai requires an LLM proxy to be configured first', async () => {
  const response = await fetch(`${base}/api/app/accounts/agent-toggle-no-llm/n8n/connect/ai`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.message, /Connect an LLM proxy/i);
});
