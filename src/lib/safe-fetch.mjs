/**
 * SSRF-safe outbound requests for server-controlled fetches of user/provider-
 * influenced URLs (link previews, automation webhooks). Two properties matter:
 *
 * 1. Validation and connection use the SAME resolved address. A plain
 *    `await dnsCheck(url); await fetch(url)` re-resolves DNS a second time at
 *    connect, which a low-TTL DNS record can flip to an internal address
 *    between the two lookups (DNS rebinding). `fetchPinned` resolves once via
 *    `validatePublicUrl` and pins the actual connection to that address with
 *    Node's `lookup` socket option.
 * 2. Redirects are re-validated per hop. A first hop can be a legitimate
 *    public URL that redirects to an internal address; each hop is resolved
 *    and pinned independently rather than trusting a single validation to
 *    cover the whole chain.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const privateAddress = address =>
  address === '::1' || address === '0.0.0.0' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd') ||
  /^10\./.test(address) || /^127\./.test(address) || /^169\.254\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address);

export async function resolvePublicAddress(hostname, { lookupImpl = dnsLookup, isPrivate = privateAddress } = {}) {
  const direct = isIP(hostname);
  const addresses = direct ? [hostname] : (await lookupImpl(hostname, { all: true, verbatim: true })).map(entry => entry.address);
  if (!addresses.length || addresses.some(isPrivate)) return null;
  return addresses[0];
}

export async function validatePublicUrl(value, { requireHttps = false, lookupImpl, isPrivate, allowPrivate = false } = {}) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const protocolOk = requireHttps ? url.protocol === 'https:' : /^https?:$/.test(url.protocol);
  if (!protocolOk) return null;
  if (!allowPrivate && (url.hostname === 'localhost' || url.hostname.endsWith('.local'))) return null;
  try {
    // allowPrivate is for admin-configured, trusted targets (e.g. a self-hosted
    // LLM proxy) where a private/local address is an expected, legitimate
    // destination rather than an SSRF risk — we still resolve once and pin
    // the connection to that address, just without rejecting private ranges.
    const address = await resolvePublicAddress(url.hostname, { lookupImpl, isPrivate: allowPrivate ? (() => false) : isPrivate });
    return address ? { url, address } : null;
  } catch { return null; }
}

function performPinnedRequest({ url, address }, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
      // Node's connection algorithm may request either the legacy single-
      // address callback form or, under Happy Eyeballs (RFC 8305), the
      // `all: true` array form — satisfy whichever the caller asked for.
      lookup: (_hostname, lookupOptions, callback) =>
        lookupOptions?.all ? callback(null, [{ address, family: isIP(address) }]) : callback(null, address, isIP(address)),
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: name => res.headers[String(name).toLowerCase()] ?? null },
          text: async () => buffer.toString('utf8'),
          arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          json: async () => JSON.parse(buffer.toString('utf8')),
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.end(options.body); else req.end();
  });
}

export async function fetchPinned(value, options = {}) {
  const maxRedirects = options.maxRedirects ?? 5;
  let target = value;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await validatePublicUrl(target, { requireHttps: options.requireHttps, lookupImpl: options.lookupImpl, isPrivate: options.isPrivate, allowPrivate: options.allowPrivate });
    if (!validated) throw Object.assign(new Error('Invalid public URL'), { status: 400 });
    const response = await performPinnedRequest(validated, options);
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    if (isRedirect && options.redirect !== 'manual') {
      const location = response.headers.get('location');
      if (!location) return response;
      target = new URL(location, validated.url).href;
      continue;
    }
    return response;
  }
  throw Object.assign(new Error('Too many redirects'), { status: 502 });
}
