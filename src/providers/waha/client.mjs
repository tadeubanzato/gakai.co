/**
 * Internal adapter for the current WhatsApp runtime.
 *
 * This is intentionally a small transport contract: callers receive parsed
 * provider responses and never need to know how this runtime authenticates.
 * A future adapter can expose the same `request` and `file` methods without
 * changing Gakai's public HTTP API.
 */
export function createWahaClient({ baseUrl, apiKey = '', fetchImpl = fetch }) {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  if (!url) throw new Error('Provider URL is required');

  const headersFor = headers => ({
    accept: 'application/json',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    ...(headers || {}),
  });

  return {
    baseUrl: url,
    async request(path, options = {}) {
      const response = await fetchImpl(`${url}${path}`, {
        ...options,
        headers: headersFor(options.headers),
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!response.ok) {
        throw Object.assign(new Error(data?.message || data || 'Provider request failed'), { status: response.status });
      }
      return data;
    },
    async file(path, extraHeaders = {}) {
      // Provider media URLs are private implementation details. Only relay
      // managed files through the authenticated Gakai endpoint.
      if (!String(path).startsWith('/api/files/')) {
        throw Object.assign(new Error('Invalid media path'), { status: 400 });
      }
      const response = await fetchImpl(`${url}${path}`, { headers: headersFor(extraHeaders) });
      if (!response.ok) throw Object.assign(new Error('Media is unavailable'), { status: response.status });
      return response;
    },
  };
}
