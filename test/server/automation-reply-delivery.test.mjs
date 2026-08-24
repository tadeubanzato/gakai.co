import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ground truth for this feature: an automation (the Gakai-managed n8n
// templates, or any hand-authored webhook) responds synchronously to the
// SAME request Gakai made to deliver the event, and Gakai sends that reply
// to WhatsApp itself — no separate outbound call from the automation back
// into Gakai's own API, and so no host/URL for it to get wrong.
const scratch = await mkdtemp(join(tmpdir(), 'gakai-automation-reply-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, sendAutomationReply, provider } = await import('../../server.mjs');
after(() => server.close());

function jsonResponse(data) {
  return { json: async () => data };
}

test('sendAutomationReply sends the "reply" field from the automation\'s response to WhatsApp', async () => {
  await sendAutomationReply(jsonResponse({ reply: 'Hi there!' }), 'account-1', '5511999999999@s.whatsapp.net');
  const sent = provider.__test.getSentMessages().filter(call => call.accountId === 'account-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, '5511999999999@s.whatsapp.net');
  assert.equal(sent[0].text, 'Hi there!');
});

test('sendAutomationReply also accepts "text" or "output" as the field name (n8n Respond to Webhook / AI Agent shapes)', async () => {
  await sendAutomationReply(jsonResponse({ text: 'via text field' }), 'account-2', 'chat-2@s.whatsapp.net');
  await sendAutomationReply(jsonResponse({ output: 'via output field' }), 'account-2', 'chat-2@s.whatsapp.net');
  const sent = provider.__test.getSentMessages().filter(call => call.accountId === 'account-2');
  assert.deepEqual(sent.map(c => c.text), ['via text field', 'via output field']);
});

test('sendAutomationReply does nothing when the response has no reply text, isn\'t JSON, or there is no chatId', async () => {
  await sendAutomationReply(jsonResponse({ reply: '' }), 'account-3', 'chat-3@s.whatsapp.net');
  await sendAutomationReply(jsonResponse({ ok: true }), 'account-3', 'chat-3@s.whatsapp.net');
  await sendAutomationReply({ json: async () => { throw new Error('not json'); } }, 'account-3', 'chat-3@s.whatsapp.net');
  await sendAutomationReply(jsonResponse({ reply: 'no chat id' }), 'account-3', undefined);
  const sent = provider.__test.getSentMessages().filter(call => call.accountId === 'account-3');
  assert.equal(sent.length, 0);
});
