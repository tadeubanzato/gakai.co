import assert from 'node:assert/strict';
import test from 'node:test';
import { chatModelIds, complete, listModels, usesFixedBaseUrl } from '../../src/lib/ai-provider.mjs';

// A fake fetch that records the request and answers with canned JSON.
function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { impl, calls };
}

test('only chatgpt and claude use a fixed endpoint', () => {
  assert.equal(usesFixedBaseUrl('chatgpt'), true);
  assert.equal(usesFixedBaseUrl('claude'), true);
  assert.equal(usesFixedBaseUrl('litellm'), false);
  assert.equal(usesFixedBaseUrl('omniroute'), false);
});

test('chatModelIds keeps ChatGPT chat models and drops embeddings, speech and image models', () => {
  const ids = ['text-embedding-3-small', 'gpt-4o', 'whisper-1', 'gpt-4o-mini', 'dall-e-3', 'o3-mini', 'gpt-4o-audio-preview', 'tts-1', 'gpt-3.5-turbo-instruct', 'gpt-4o'];
  assert.deepEqual(chatModelIds('chatgpt', ids), ['gpt-4o', 'gpt-4o-mini', 'o3-mini']);
});

test('chatModelIds leaves LiteLLM model names alone, deduplicated and sorted', () => {
  assert.deepEqual(chatModelIds('litellm', ['zeta', 'text-embedding-x', 'alpha', 'alpha']), ['alpha', 'text-embedding-x', 'zeta']);
});

test('listModels asks a LiteLLM proxy for /models with a bearer key and its own URL', async () => {
  const { impl, calls } = fakeFetch({ data: [{ id: 'claude-sonnet' }, { id: 'gpt-4o' }] });
  const models = await listModels({ provider: 'litellm', baseUrl: 'http://litellm.local:4000/v1', apiKey: 'sk-test', fetchImpl: impl });
  assert.deepEqual(models, ['claude-sonnet', 'gpt-4o']);
  assert.equal(calls[0].url, 'http://litellm.local:4000/v1/models');
  assert.equal(calls[0].options.headers.authorization, 'Bearer sk-test');
  assert.equal(calls[0].options.allowPrivate, true);
});

test('listModels ignores any supplied URL for ChatGPT and Claude and never allows private targets', async () => {
  const openai = fakeFetch({ data: [{ id: 'gpt-4o' }] });
  await listModels({ provider: 'chatgpt', baseUrl: 'http://evil.example', apiKey: 'k', fetchImpl: openai.impl });
  assert.equal(openai.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(openai.calls[0].options.allowPrivate, false);

  const anthropic = fakeFetch({ data: [{ id: 'claude-opus-4' }] });
  const models = await listModels({ provider: 'claude', baseUrl: 'http://evil.example', apiKey: 'k', fetchImpl: anthropic.impl });
  assert.deepEqual(models, ['claude-opus-4']);
  assert.equal(anthropic.calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(anthropic.calls[0].options.headers['x-api-key'], 'k');
  assert.equal(anthropic.calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(anthropic.calls[0].options.headers.authorization, undefined);
});

test('listModels surfaces the provider error and status for a rejected key', async () => {
  const { impl } = fakeFetch({ error: { message: 'Incorrect API key' } }, { status: 401 });
  await assert.rejects(() => listModels({ provider: 'chatgpt', apiKey: 'bad', fetchImpl: impl }), error => error.status === 401 && /Incorrect API key/.test(error.message));
});

test('listModels requires a key, and a URL for a proxy', async () => {
  await assert.rejects(() => listModels({ provider: 'litellm', baseUrl: 'http://x/v1', apiKey: '' }), /API key/);
  await assert.rejects(() => listModels({ provider: 'litellm', baseUrl: '', apiKey: 'k' }), /proxy URL/);
});

test('complete sends an OpenAI-style chat completion for LiteLLM and returns the reply text', async () => {
  const { impl, calls } = fakeFetch({ choices: [{ message: { content: 'Hello!' } }] });
  const reply = await complete({ provider: 'litellm', baseUrl: 'http://proxy/v1', apiKey: 'k', model: 'm' }, [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }], { maxTokens: 5, fetchImpl: impl });
  assert.equal(reply, 'Hello!');
  assert.equal(calls[0].url, 'http://proxy/v1/chat/completions');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'm', stream: false, messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }], max_tokens: 5 });
});

test('complete sends Claude the system prompt as a top-level field with max_tokens, and joins text blocks', async () => {
  const { impl, calls } = fakeFetch({ content: [{ type: 'text', text: 'Hi ' }, { type: 'tool_use' }, { type: 'text', text: 'there' }] });
  const reply = await complete({ provider: 'claude', apiKey: 'k', model: 'claude-sonnet' }, [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }], { fetchImpl: impl });
  assert.equal(reply, 'Hi there');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'claude-sonnet', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }], system: 'be nice' });
});

test('complete throws with the HTTP status so callers can tell a 400 from an outage', async () => {
  const { impl } = fakeFetch({ error: { message: 'bad model' } }, { status: 400 });
  await assert.rejects(() => complete({ provider: 'chatgpt', apiKey: 'k', model: 'x' }, [{ role: 'user', content: 'hi' }], { fetchImpl: impl }), error => error.status === 400 && /bad model/.test(error.message));
});
