import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// Ground truth for this feature: an automation (the Gakai-managed n8n
// templates, or any hand-authored webhook) responds synchronously to the
// SAME request Gakai made to deliver the event, and Gakai sends that reply
// to WhatsApp itself — no separate outbound call from the automation back
// into Gakai's own API, and so no host/URL for it to get wrong.
let sendTextCalls = [];
const mockProvider = http.createServer((req, res) => {
  if (req.url === '/api/sendText') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      sendTextCalls.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockProviderPort = mockProvider.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-automation-reply-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_URL = `http://127.0.0.1:${mockProviderPort}`;

const { server, sendAutomationReply } = await import('../../server.mjs');
after(() => { server.close(); mockProvider.close(); });

function jsonResponse(data) {
  return { json: async () => data };
}

test('sendAutomationReply sends the "reply" field from the automation\'s response to WhatsApp', async () => {
  sendTextCalls = [];
  await sendAutomationReply(jsonResponse({ reply: 'Hi there!' }), 'account-1', '5511999999999@c.us');
  assert.equal(sendTextCalls.length, 1);
  assert.equal(sendTextCalls[0].session, 'account-1');
  assert.equal(sendTextCalls[0].chatId, '5511999999999@c.us');
  assert.equal(sendTextCalls[0].text, 'Hi there!');
});

test('sendAutomationReply also accepts "text" or "output" as the field name (n8n Respond to Webhook / AI Agent shapes)', async () => {
  sendTextCalls = [];
  await sendAutomationReply(jsonResponse({ text: 'via text field' }), 'account-2', 'chat-2@c.us');
  await sendAutomationReply(jsonResponse({ output: 'via output field' }), 'account-2', 'chat-2@c.us');
  assert.deepEqual(sendTextCalls.map(c => c.text), ['via text field', 'via output field']);
});

test('sendAutomationReply does nothing when the response has no reply text, isn\'t JSON, or there is no chatId', async () => {
  sendTextCalls = [];
  await sendAutomationReply(jsonResponse({ reply: '' }), 'account-3', 'chat-3@c.us');
  await sendAutomationReply(jsonResponse({ ok: true }), 'account-3', 'chat-3@c.us');
  await sendAutomationReply({ json: async () => { throw new Error('not json'); } }, 'account-3', 'chat-3@c.us');
  await sendAutomationReply(jsonResponse({ reply: 'no chat id' }), 'account-3', undefined);
  assert.equal(sendTextCalls.length, 0);
});
