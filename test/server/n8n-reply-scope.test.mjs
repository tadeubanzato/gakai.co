import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The "enable n8n replies" toggle is only meaningful if a direct message
// always qualifies and a group message only qualifies when the account is
// @-tagged — this exercises dispatchAutomationEvent's scoping directly, the
// same way a live inbound WhatsApp message now reaches it (in-process,
// no webhook to sign).
const OWN_ID = '5511999999999@s.whatsapp.net';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-n8n-reply-scope-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, store, provider, dispatchAutomationEvent } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));

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

async function dispatchEvent(accountId, chatId, overrides = {}) {
  provider.__test.seedAccount(accountId, { ownJid: OWN_ID });
  await dispatchAutomationEvent({
    accountId, chatId,
    message: { id: `msg-${Math.random()}`, body: 'hello', text: 'hello', hasMedia: false, sender: { id: '5511988887777@s.whatsapp.net' }, mentionedJids: [], ...overrides },
  });
  // deliverAutomation runs inside Promise.allSettled synchronously awaited by
  // dispatchAutomationEvent, so no extra wait is needed — unlike the old
  // fire-and-forget webhook receiver.
}

test('a direct message dispatches to the n8n auto-connect subscription', async () => {
  const accountId = 'n8n-scope-direct';
  const subscription = n8nSubscriptionFor(accountId);
  store.automationSubscriptions.push(subscription);

  await dispatchEvent(accountId, '5511988887777@s.whatsapp.net');
  assert.ok(subscription.lastDelivery, 'a direct message must always be dispatched');
});

test('a group message with no mention of the account is not dispatched', async () => {
  const accountId = 'n8n-scope-group-no-mention';
  const subscription = n8nSubscriptionFor(accountId);
  store.automationSubscriptions.push(subscription);

  await dispatchEvent(accountId, '120363000000000000@g.us');
  assert.equal(subscription.lastDelivery, null, 'an untagged group message must not reach n8n at all');
});

test('a group message with mentions that do not include the account is not dispatched', async () => {
  const accountId = 'n8n-scope-group-other-mention';
  const subscription = n8nSubscriptionFor(accountId);
  store.automationSubscriptions.push(subscription);

  await dispatchEvent(accountId, '120363000000000000@g.us', { mentionedJids: ['5511000000000@s.whatsapp.net'] });
  assert.equal(subscription.lastDelivery, null, 'being tagged is about this account specifically, not any mention at all');
});

test('a group message that @-tags the account is dispatched', async () => {
  const accountId = 'n8n-scope-group-mentioned';
  const subscription = n8nSubscriptionFor(accountId);
  store.automationSubscriptions.push(subscription);

  await dispatchEvent(accountId, '120363000000000000@g.us', { mentionedJids: [OWN_ID] });
  assert.ok(subscription.lastDelivery, 'a group message tagging the account must be dispatched');
});

test('a disabled n8n auto-connect subscription is never dispatched, even for a direct message', async () => {
  const accountId = 'n8n-scope-disabled';
  const subscription = { ...n8nSubscriptionFor(accountId), enabled: false };
  store.automationSubscriptions.push(subscription);

  await dispatchEvent(accountId, '5511988887777@s.whatsapp.net');
  assert.equal(subscription.lastDelivery, null, 'the enabled flag (the "Send test message" toggle) must still gate dispatch entirely');
});

test('a hand-authored automation subscription (not the built-in n8n integration) is unaffected by the DM/mention scope', async () => {
  const accountId = 'n8n-scope-custom-automation';
  const subscription = { ...n8nSubscriptionFor(accountId), id: `custom-${accountId}`, name: 'my custom webhook' };
  store.automationSubscriptions.push(subscription);

  await dispatchEvent(accountId, '120363000000000000@g.us');
  assert.ok(subscription.lastDelivery, 'only the Gakai-managed n8n subscriptions are scoped to DMs/mentions — a custom automation still gets every message');
});
