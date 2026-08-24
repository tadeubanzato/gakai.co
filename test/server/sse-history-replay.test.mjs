import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-sse-history-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_WEBHOOK_SECRET = 'test-webhook-secret';

const { server } = await import('../../server.mjs');
after(() => { server.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'sse-history-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

async function postWebhookEvent(accountId, messageId) {
  const body = JSON.stringify({
    event: 'message', session: accountId,
    payload: { id: { _serialized: messageId }, from: '5511999999999@c.us', fromMe: false, body: 'hello', text: 'hello', timestamp: Math.floor(Date.now() / 1000), hasMedia: false },
  });
  const signature = createHmac('sha512', 'test-webhook-secret').update(body).digest('hex');
  const response = await fetch(`${base}/api/app/provider-events`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-hmac': signature }, body,
  });
  assert.equal(response.status, 202);
  // Recording happens synchronously in the request handler before the 202,
  // but dispatch (automations/AI replies) runs fire-and-forget after — give
  // it a moment so it can't leak into a later test's provider calls.
  await new Promise(resolve => setTimeout(resolve, 150));
}

// Connects, collects any "gakai" SSE events received within a short window,
// then aborts (the connection is otherwise held open forever) and returns
// what arrived. A short window is inherent to proving *absence* of a replay.
async function collectSseEvents(url, waitMs = 400) {
  const controller = new AbortController();
  const events = [];
  try {
    const response = await fetch(url, { headers: { cookie }, signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = chunk.split('\n').find(line => line.startsWith('data: '));
          if (dataLine) events.push(JSON.parse(dataLine.slice('data: '.length)));
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Expected: the abort itself throws.
  }
  return events;
}

test('without after=now, a fresh SSE connection replays recent history for that account', async () => {
  const accountId = 'replay-account';
  await postWebhookEvent(accountId, 'history-msg-1');

  const events = await collectSseEvents(`${base}/api/app/events?accountId=${accountId}`);
  assert.ok(events.some(event => event.message?.id === 'history-msg-1'), 'the already-recorded event must be replayed on connect');
});

test('after=now opts a fresh SSE connection out of the history replay entirely', async () => {
  const accountId = 'no-replay-account';
  await postWebhookEvent(accountId, 'history-msg-2');

  const events = await collectSseEvents(`${base}/api/app/events?accountId=${accountId}&after=now`);
  assert.equal(events.length, 0, 'a subscriber that opted out of replay must not receive history it never asked for');
});

test('after=now still delivers a genuinely new event live, once connected', async () => {
  const accountId = 'live-after-now-account';
  const controller = new AbortController();
  const response = await fetch(`${base}/api/app/events?accountId=${accountId}&after=now`, { headers: { cookie }, signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const found = new Promise((resolve, reject) => {
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return resolve(null);
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = chunk.split('\n').find(line => line.startsWith('data: '));
            if (dataLine) {
              const event = JSON.parse(dataLine.slice('data: '.length));
              if (event.message?.id === 'live-msg-1') return resolve(event);
            }
          }
        }
      } catch (error) { reject(error); }
    })();
  });

  await new Promise(resolve => setTimeout(resolve, 50)); // let the connection register before firing the event
  await postWebhookEvent(accountId, 'live-msg-1');

  const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), 800));
  const result = await Promise.race([found, timeout]);
  controller.abort();
  assert.notEqual(result, 'timeout', 'a live event must still reach an after=now subscriber');
  assert.equal(result?.message?.id, 'live-msg-1');
});
