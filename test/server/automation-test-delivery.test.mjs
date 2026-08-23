import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-automation-test-delivery-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server, store } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'test-delivery-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('testing an automation updates subscription.lastDelivery, even when the send itself fails', async () => {
  const accountId = 'test-delivery-account';
  // Nothing listens on port 1 (connection refused instantly) — the point of
  // this test is that lastDelivery is now recorded regardless of outcome,
  // not that the send succeeds.
  const subscription = {
    id: 'sub-under-test', accountId, name: 'test automation',
    url: 'https://127.0.0.1:1/webhook/unreachable', productionUrl: 'https://127.0.0.1:1/webhook/unreachable', testUrl: null, testPhone: null,
    enabled: true, events: ['message.received'], secret: 'test-secret', createdAt: new Date().toISOString(), lastDelivery: null,
  };
  store.automationSubscriptions.push(subscription);
  assert.equal(subscription.lastDelivery, null);

  const response = await fetch(`${base}/api/app/accounts/${accountId}/automations/${subscription.id}/test`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({}),
  });
  await response.json();

  assert.equal(response.status, 502, 'the send itself is expected to fail against an unreachable destination');
  assert.ok(subscription.lastDelivery, 'lastDelivery must be populated by a test send, the same as a production send');
  assert.equal(subscription.lastDelivery.ok, false);
});
