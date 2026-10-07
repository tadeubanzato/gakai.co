import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-describe-webhook-failure-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server, describeWebhookFailure } = await import('../../server.mjs');
after(() => server.close());

// A receiver's JSON error body often already says what is wrong (a `hint` or `message`
// field), so Gakai shows that instead of a bare "Webhook returned 404".
test('a 404 with a "workflow must be active" hint surfaces that hint, not a bare status code', async () => {
  const response = new Response(JSON.stringify({
    code: 404,
    message: 'The requested webhook "POST gakai-test" is not registered.',
    hint: 'The workflow must be active for a production URL to run successfully.',
  }), { status: 404, headers: { 'content-type': 'application/json' } });

  const message = await describeWebhookFailure(response);
  assert.match(message, /workflow must be active/i);
  assert.doesNotMatch(message, /^Webhook returned 404$/);
});

test('a 404 with no parseable body falls back to a generic "not found" explanation', async () => {
  const response = new Response('not json', { status: 404 });
  const message = await describeWebhookFailure(response);
  assert.match(message, /not found \(404\)/i);
});

test('a non-404 failure still reports the status code, plus any body detail available', async () => {
  const response = new Response(JSON.stringify({ message: 'Internal error' }), { status: 500, headers: { 'content-type': 'application/json' } });
  const message = await describeWebhookFailure(response);
  assert.match(message, /500/);
  assert.match(message, /Internal error/);
});

test('a non-404 failure with no parseable body just reports the status code', async () => {
  const response = new Response('', { status: 503 });
  const message = await describeWebhookFailure(response);
  assert.equal(message, 'Webhook returned 503');
});
