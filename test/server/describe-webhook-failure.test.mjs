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

// n8n's real response for a webhook path whose workflow exists but was never
// activated/published: a 404 whose JSON body already explains this via a
// `hint` field. This is the ordinary "forgot to publish" case, not a wrong
// URL — the reported bug was that Gakai discarded this and showed a bare
// "Webhook returned 404" instead.
test('a 404 with an n8n "workflow must be active" hint surfaces that hint, not a bare status code', async () => {
  const response = new Response(JSON.stringify({
    code: 404,
    message: 'The requested webhook "POST gakai-test" is not registered.',
    hint: 'The workflow must be active for a production URL to run successfully.',
  }), { status: 404, headers: { 'content-type': 'application/json' } });

  const message = await describeWebhookFailure(response);
  assert.match(message, /workflow must be active/i);
  assert.doesNotMatch(message, /^Webhook returned 404$/);
});

test('a 404 with no parseable body falls back to a generic "not published yet" explanation', async () => {
  const response = new Response('not json', { status: 404 });
  const message = await describeWebhookFailure(response);
  assert.match(message, /isn't published yet/i);
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
