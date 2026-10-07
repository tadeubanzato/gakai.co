import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

let llmHits = 0;
const mockLlmProxy = http.createServer((req, res) => {
  llmHits += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'mock reply' } }] }));
});
await new Promise(resolve => mockLlmProxy.listen(0, '127.0.0.1', resolve));
const mockLlmProxyPort = mockLlmProxy.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-dual-ai-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, store, dispatchAutomationEvent } = await import('../../server.mjs');
after(() => { server.close(); mockLlmProxy.close(); });

function llmConfigFor(accountId) {
  return { accountId, provider: 'omniroute', baseUrl: `http://127.0.0.1:${mockLlmProxyPort}`, apiKey: 'test-key', model: 'test-model', systemPrompt: '', nativeEnabled: true, replyRules: { numbers: ['5511999999999'], groups: [] }, configuredAt: new Date().toISOString() };
}

async function dispatchMessage(accountId, messageId, overrides = {}) {
  await dispatchAutomationEvent({
    accountId, chatId: '5511999999999@s.whatsapp.net',
    message: { id: messageId, body: 'hello', text: 'hello', hasMedia: false, sender: null, mentionedJids: [], ...overrides },
  });
}

test('native LLM reply fires for a listed number', async () => {
  const accountId = 'native-account';
  store.llmConfigs.push(llmConfigFor(accountId));

  const before = llmHits;
  await dispatchMessage(accountId, 'msg-1');
  assert.equal(llmHits, before + 1, 'native LLM must be dispatched for a listed number');
});

test('a "message" event with no body, text, or media is not dispatched to native AI reply', async () => {
  // Mirrors the inbox's ghost-timestamp finding (a metadata touch with no
  // real content behind it) — if that ever reaches dispatch, it must not
  // trigger an AI reply either.
  const accountId = 'ghost-event-account';
  store.llmConfigs.push(llmConfigFor(accountId));

  const before = llmHits;
  await dispatchMessage(accountId, 'msg-ghost', { body: '', text: '', hasMedia: false });
  assert.equal(llmHits, before, 'a contentless event must not trigger a native AI reply');
});
