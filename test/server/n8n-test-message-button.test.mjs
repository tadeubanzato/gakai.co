import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-n8n-test-message-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server, store } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'n8n-test-message-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('GET /n8n/connect exposes the subscriptionId the client needs to call the "Send test message" button', async () => {
  // The Settings UI's "Send test message" button posts to
  // /automations/:subscriptionId/test — it can only build that request if
  // the connect status response tells it which automationSubscriptions
  // entry backs the connected n8n workflow.
  const accountId = 'n8n-test-message-account';
  store.n8nConnections.push({
    accountId, kind: 'standard', n8nUrl: 'https://example.n8n.cloud', n8nApiKeyEncrypted: null,
    workflowId: 'wf-1', workflowName: 'Gakai automation', webhookUrl: 'https://example.n8n.cloud/webhook/abc',
    connectedAt: new Date().toISOString(),
  });
  store.automationSubscriptions.push({
    id: 'sub-for-standard-workflow', accountId, name: 'n8n auto-connect',
    url: 'https://example.n8n.cloud/webhook/abc', productionUrl: 'https://example.n8n.cloud/webhook/abc', testUrl: null, testPhone: null,
    enabled: true, events: ['message.received'], secret: 'unused', createdAt: new Date().toISOString(), lastDelivery: null,
  });

  const response = await fetch(`${base}/api/app/accounts/${accountId}/n8n/connect`, { headers: { cookie } });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.connected, true);
  const standard = body.workflows.find(workflow => workflow.kind === 'standard');
  assert.equal(standard.subscriptionId, 'sub-for-standard-workflow');
});
