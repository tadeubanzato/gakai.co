import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { URL as NodeURL } from 'node:url';

// The "enable n8n replies" toggle is only meaningful if a direct message
// always qualifies and a group message only qualifies when the account is
// @-tagged — this exercises dispatchAutomationEvent's scoping directly
// through the real webhook path, not just the pure mentionsIdentity() unit.
const OWN_ID = '5511999999999@c.us';

const mockProvider = http.createServer((req, res) => {
  const requestUrl = new NodeURL(req.url, 'http://mock-provider');
  res.writeHead(200, { 'content-type': 'application/json' });
  if (/^\/api\/sessions\//.test(requestUrl.pathname)) return res.end(JSON.stringify({ me: { id: OWN_ID } }));
  res.end('{}');
});
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockProviderPort = mockProvider.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-n8n-reply-scope-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;

const { server, store } = await import('../../server.mjs');
after(() => { server.close(); mockProvider.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

function n8nSubscriptionFor(accountId) {
  // An unreachable-but-syntactically-valid HTTPS target (nothing listens on
  // port 1): deliverAutomation always records lastDelivery — success or
  // failure — the instant it's invoked, which is enough to prove dispatch
  // was attempted without needing a real reachable receiver.
  return {
    id: `sub-${accountId}`, accountId, name: 'n8n auto-connect',
    url: 'https://127.0.0.1:1/webhook/unreachable', productionUrl: 'https://127.0.0.1:1/webhook/unreachable', testUrl: null, testPhone: null,
    enabled: true, events: ['message.received'], secret: 'test-secret', createdAt: new Date().toISOString(), lastDelivery: null,
  };
}

async function postWebhookEvent(accountId, messageId, payloadOverrides = {}) {
  const body = JSON.stringify({
    event: 'message', session: accountId,
    payload: { id: { _serialized: messageId }, from: '5511988887777@c.us', fromMe: false, body: 'hello', text: 'hello', timestamp: Math.floor(Date.now() / 1000), hasMedia: false, ...payloadOverrides },
  });
  const signature = createHmac('sha512', 'test-webhook-secret').update(body).digest('hex');
  const response = await fetch(`${base}/api/app/provider-events`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-hmac': signature }, body,
  });
  assert.equal(response.status, 202);
  // Dispatch runs fire-and-forget after the 202 response; give it a window to finish.
  await new Promise(resolve => setTimeout(resolve, 300));
}

test('a direct message dispatches to the n8n auto-connect subscription', async () => {
  const accountId = 'n8n-scope-direct';
  const subscription = n8nSubscriptionFor(accountId);
  store.automationSubscriptions.push(subscription);

  await postWebhookEvent(accountId, 'msg-direct', { from: '5511988887777@c.us' });
  assert.ok(subscription.lastDelivery, 'a direct message must always be dispatched');
});

test('a group message with no mention of the account is not dispatched', async () => {
  const accountId = 'n8n-scope-group-no-mention';
  const subscription = n8nSubscriptionFor(accountId);
  store.automationSubscriptions.push(subscription);

  await postWebhookEvent(accountId, 'msg-group', { from: '120363000000000000@g.us' });
  assert.equal(subscription.lastDelivery, null, 'an untagged group message must not reach n8n at all');
});

test('a group message with mentions that do not include the account is not dispatched', async () => {
  const accountId = 'n8n-scope-group-other-mention';
  const subscription = n8nSubscriptionFor(accountId);
  store.automationSubscriptions.push(subscription);

  await postWebhookEvent(accountId, 'msg-group-other', { from: '120363000000000000@g.us', _data: { mentionedJidList: ['5511000000000@c.us'] } });
  assert.equal(subscription.lastDelivery, null, 'being tagged is about this account specifically, not any mention at all');
});

test('a group message that @-tags the account is dispatched', async () => {
  const accountId = 'n8n-scope-group-mentioned';
  const subscription = n8nSubscriptionFor(accountId);
  store.automationSubscriptions.push(subscription);

  await postWebhookEvent(accountId, 'msg-group-mentioned', { from: '120363000000000000@g.us', _data: { mentionedJidList: [OWN_ID] } });
  assert.ok(subscription.lastDelivery, 'a group message tagging the account must be dispatched');
});

test('a disabled n8n auto-connect subscription is never dispatched, even for a direct message', async () => {
  const accountId = 'n8n-scope-disabled';
  const subscription = { ...n8nSubscriptionFor(accountId), enabled: false };
  store.automationSubscriptions.push(subscription);

  await postWebhookEvent(accountId, 'msg-disabled', { from: '5511988887777@c.us' });
  assert.equal(subscription.lastDelivery, null, 'the enabled flag (the "Send test message" toggle) must still gate dispatch entirely');
});

test('a hand-authored automation subscription (not the built-in n8n integration) is unaffected by the DM/mention scope', async () => {
  const accountId = 'n8n-scope-custom-automation';
  const subscription = { ...n8nSubscriptionFor(accountId), id: `custom-${accountId}`, name: 'my custom webhook' };
  store.automationSubscriptions.push(subscription);

  await postWebhookEvent(accountId, 'msg-custom', { from: '120363000000000000@g.us' });
  assert.ok(subscription.lastDelivery, 'only the Gakai-managed n8n subscriptions are scoped to DMs/mentions — a custom automation still gets every message');
});
