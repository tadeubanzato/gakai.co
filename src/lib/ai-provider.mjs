// AI Responses provider adapter: one place that knows how to list models and
// run a chat completion for each supported backend. Gakai's API and UI only
// see { provider, baseUrl, apiKey, model } and plain { role, content } turns.
//
//   litellm / omniroute — self-hosted OpenAI-compatible proxy (user URL + key)
//   chatgpt             — OpenAI API (fixed URL, user key)
//   claude              — Anthropic Messages API (fixed URL, user key)
import { fetchPinned } from './safe-fetch.mjs';

export const AI_PROVIDER_IDS = ['litellm', 'claude', 'chatgpt', 'omniroute'];
// Cloud providers have one fixed endpoint, so the browser never supplies a URL
// for them (nothing for an attacker-controlled URL to redirect a key to).
export const FIXED_BASE_URLS = {
  chatgpt: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com/v1',
};
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

export const usesFixedBaseUrl = provider => provider in FIXED_BASE_URLS;

function joinUrl(base, path, query = '') {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/\/+/g, '/');
  if (query) url.search = query;
  return url.href;
}

function authHeaders(provider, apiKey) {
  if (provider === 'claude') return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  return { authorization: `Bearer ${apiKey}` };
}

// Self-hosted proxies may live on a private address; the fixed cloud
// endpoints never should.
const allowPrivate = provider => !usesFixedBaseUrl(provider);

async function readJson(response, label) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `${label} returned ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  if (data === null) throw Object.assign(new Error(`${label} returned invalid JSON`), { status: 502 });
  return data;
}

// OpenAI's /models also lists embeddings, speech, image and moderation models
// that cannot answer a chat message — keep only the chat-capable families.
const OPENAI_CHAT = /^(gpt-|chatgpt-|o\d)/i;
const OPENAI_NOT_CHAT = /(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|whisper|dall-e)/i;

export function chatModelIds(provider, ids) {
  const unique = [...new Set(ids.filter(id => typeof id === 'string' && id))];
  const filtered = provider === 'chatgpt' ? unique.filter(id => OPENAI_CHAT.test(id) && !OPENAI_NOT_CHAT.test(id)) : unique;
  return filtered.sort((a, b) => a.localeCompare(b));
}

// Asks the provider itself which models this key can use. Doubles as a cheap
// credential check: a bad key or unreachable URL fails here with a clear error.
export async function listModels({ provider, baseUrl, apiKey, fetchImpl = fetchPinned }) {
  if (!apiKey) throw Object.assign(new Error('An API key is required to load models'), { status: 400 });
  const base = FIXED_BASE_URLS[provider] || baseUrl;
  if (!base) throw Object.assign(new Error('A proxy URL is required to load models'), { status: 400 });
  const url = joinUrl(base, 'models', provider === 'claude' ? 'limit=1000' : '');
  const response = await fetchImpl(url, {
    allowPrivate: allowPrivate(provider),
    method: 'GET',
    headers: { accept: 'application/json', ...authHeaders(provider, apiKey) },
    signal: AbortSignal.timeout(15000),
  });
  const data = await readJson(response, 'Model list');
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return chatModelIds(provider, rows.map(row => (typeof row === 'string' ? row : row?.id || row?.model_name)));
}

// One non-streaming completion. `messages` are { role: system|user|assistant,
// content }; returns the reply text.
export async function complete(config, messages, { maxTokens, timeoutMs = 30000, fetchImpl = fetchPinned } = {}) {
  const { provider, apiKey, model } = config;
  const base = FIXED_BASE_URLS[provider] || config.baseUrl;
  const common = { allowPrivate: allowPrivate(provider), method: 'POST', signal: AbortSignal.timeout(timeoutMs) };

  if (provider === 'claude') {
    // Anthropic takes the system prompt as a top-level field, and requires max_tokens.
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const turns = messages.filter(m => m.role !== 'system');
    const body = { model, max_tokens: maxTokens || DEFAULT_MAX_TOKENS, messages: turns, ...(system ? { system } : {}) };
    const response = await fetchImpl(joinUrl(base, 'messages'), {
      ...common,
      headers: { 'content-type': 'application/json', ...authHeaders(provider, apiKey) },
      body: JSON.stringify(body),
    });
    const data = await readJson(response, 'Claude');
    return (data.content || []).filter(block => block?.type === 'text').map(block => block.text).join('');
  }

  const body = { model, stream: false, messages, ...(maxTokens ? { max_tokens: maxTokens } : {}) };
  const response = await fetchImpl(joinUrl(base, 'chat/completions'), {
    ...common,
    headers: { 'content-type': 'application/json', ...authHeaders(provider, apiKey) },
    body: JSON.stringify(body),
  });
  const data = await readJson(response, provider === 'chatgpt' ? 'ChatGPT' : 'LLM proxy');
  return data?.choices?.[0]?.message?.content || '';
}
