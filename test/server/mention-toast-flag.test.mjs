import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The browser raises a mention toast off `event.mentionsYou` on the account's
// SSE stream. That flag must mean the narrow thing: this account was
// explicitly @-tagged in a *group*. A direct message is not a mention, and a
// group message tagging someone else is not a mention of you.
const OWN_ID = '5511999999999@s.whatsapp.net';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-mention-toast-flag-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider, dispatchAutomationEvent } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'mention-flag-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

async function firstEvent(accountId, messageId) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/app/events?accountId=${accountId}`, { headers: { cookie }, signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk.split('\n').find(line => line.startsWith('data: '));
        if (dataLine) {
          const event = JSON.parse(dataLine.slice('data: '.length));
          if (event.message?.id === messageId) return event;
        }
      }
    }
  } finally {
    controller.abort();
  }
}

async function dispatch(accountId, chatId, messageId, overrides = {}) {
  provider.__test.seedAccount(accountId, { ownJid: OWN_ID });
  await dispatchAutomationEvent({
    accountId, chatId,
    message: { id: messageId, body: 'yo', text: 'yo', hasMedia: false, sender: { id: '5511988887777@s.whatsapp.net' }, mentionedJids: [], ...overrides },
  });
}

test('a group message that @-tags the account is flagged mentionsYou', async () => {
  await dispatch('mtf-tagged', '120363000000000003@g.us', 'mtf-1', { mentionedJids: [OWN_ID] });
  const event = await firstEvent('mtf-tagged', 'mtf-1');
  assert.equal(event.mentionsYou, true);
});

test('a group message tagging someone else is not flagged', async () => {
  await dispatch('mtf-other', '120363000000000003@g.us', 'mtf-2', { mentionedJids: ['5511000000000@s.whatsapp.net'] });
  const event = await firstEvent('mtf-other', 'mtf-2');
  assert.equal(event.mentionsYou, false);
});

test('a direct message is recorded but is not a mention', async () => {
  await dispatch('mtf-dm', '5511988887777@s.whatsapp.net', 'mtf-3');
  const event = await firstEvent('mtf-dm', 'mtf-3');
  assert.equal(event.mentionsYou, false);
});
