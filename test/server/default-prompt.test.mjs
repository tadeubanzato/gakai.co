import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// Stands in for the LLM proxy's connection-verification call the save route
// makes; any 200 satisfies it.
const mockLlmProxy = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
await new Promise(resolve => mockLlmProxy.listen(0, '127.0.0.1', resolve));
const mockLlmProxyPort = mockLlmProxy.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'gakai-default-prompt-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server, store } = await import('../../server.mjs');
after(() => { server.close(); mockLlmProxy.close(); });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'prompt-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('saving an LLM config with no system prompt does not persist the placeholder phone-number gate', async () => {
  const accountId = 'prompt-test-account';
  const response = await fetch(`${base}/api/app/accounts/${accountId}/llm`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockLlmProxyPort}/v1`, apiKey: 'test-key', model: 'test-model', systemPrompt: '' }),
  });
  assert.equal(response.status, 200);

  const saved = store.llmConfigs.find(item => item.accountId === accountId);
  assert.ok(saved, 'the config must have been persisted');
  assert.doesNotMatch(saved.systemPrompt, /approved phone numbers/i);
  assert.doesNotMatch(saved.systemPrompt, /\+1555\d{7}/);
});
