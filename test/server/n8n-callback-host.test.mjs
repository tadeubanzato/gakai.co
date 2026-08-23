import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-n8n-callback-host-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server, invalidN8nCallbackHost } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'callback-host-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

function rawPost(path, host, body) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(body, 'utf8');
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        `POST ${path} HTTP/1.1`,
        `Host: ${host}`,
        `Content-Type: application/json`,
        `Content-Length: ${bytes.length}`,
        `Cookie: ${cookie}`,
        `Connection: close`,
        '', '',
      ].join('\r\n'));
      socket.write(bytes);
    });
    let raw = '';
    socket.on('data', chunk => { raw += chunk.toString('utf8'); });
    socket.on('end', () => {
      const statusMatch = raw.match(/^HTTP\/1\.\d (\d+)/);
      const bodyText = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      resolve({ status: Number(statusMatch?.[1]), body: bodyText });
    });
    socket.on('error', reject);
  });
}

test('invalidN8nCallbackHost rejects loopback and .local (mDNS) hostnames', () => {
  // The actual reported bug: a browser reaching Gakai at "okame.local" (a
  // macOS Bonjour hostname) got that host baked into the n8n workflow's
  // outbound Send Reply node. mDNS only resolves for a client on the same
  // LAN that also does mDNS lookups itself — n8n Cloud, a Docker container,
  // most VMs don't — so n8n's HTTP node failed with getaddrinfo ENOTFOUND at
  // delivery time, not at connect time when it's easy to catch and explain.
  assert.ok(invalidN8nCallbackHost('http://okame.local:3000'));
  assert.ok(invalidN8nCallbackHost('http://localhost:3000'));
  assert.ok(invalidN8nCallbackHost('http://127.0.0.1:3000'));
  assert.ok(invalidN8nCallbackHost('http://[::1]:3000'));
  assert.doesNotMatch(invalidN8nCallbackHost('http://okame.local:3000'), /local hostname/i, 'the error copy must not claim a .local hostname works');
});

test('invalidN8nCallbackHost accepts a LAN IP or a real domain', () => {
  assert.equal(invalidN8nCallbackHost('http://192.168.1.50:3000'), null);
  assert.equal(invalidN8nCallbackHost('https://gakai.example.com'), null);
});

test('POST /n8n/connect rejects a .local Host header with a 400 before ever attempting to reach n8n', async () => {
  const path = `/api/app/accounts/callback-host-local-account/n8n/connect`;
  const requestBody = JSON.stringify({ n8nUrl: 'https://example.app.n8n.cloud', n8nApiKey: 'test-key' });

  // If this reached n8nRequest() it would try to actually contact
  // example.app.n8n.cloud and fail differently (network error, not this
  // specific 400) — asserting exactly 400 here proves the callback-host
  // guard is what stopped it, not some other unrelated failure.
  const result = await rawPost(path, 'okame.local:3000', requestBody);
  assert.equal(result.status, 400);
  assert.doesNotMatch(result.body, /local hostname/i, 'the error copy must not claim a .local hostname works');
  assert.match(result.body, /LAN IP|GAKAI_PUBLIC_URL/i);
});

test('POST /n8n/connect does not reject a LAN-IP Host header on the callback-host check (fails later, for an unrelated reason)', async () => {
  const path = `/api/app/accounts/callback-host-lan-account/n8n/connect`;
  // Port 1: connection refused instantly, no real network dependency or
  // timeout wait — the point here is only that the callback-host guard lets
  // a LAN IP through, not that n8n connection succeeds.
  const requestBody = JSON.stringify({ n8nUrl: 'https://127.0.0.1:1/', n8nApiKey: 'test-key' });

  const result = await rawPost(path, '192.168.1.50:3000', requestBody);
  // A LAN IP passes the callback-host guard, so this 400 comes from n8n
  // itself being unreachable instead (a connection-refused wrapped by
  // undici's fetch as "fetch failed") — not from the callback-host message.
  assert.equal(result.status, 400);
  assert.doesNotMatch(result.body, /callback URL/i);
});
