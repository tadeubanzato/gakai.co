import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

// server.mjs runs top-level setup on import, so environment must be set first.
const scratch = await mkdtemp(join(tmpdir(), 'gakai-n8n-race-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setupResponse = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'race-admin', password: 'a-long-enough-password' }),
});
assert.equal(setupResponse.status, 201);
const setCookie = setupResponse.headers.get('set-cookie');
const sessionCookie = setCookie.split(';')[0]; // "home_session=<token>"

// Unreachable-but-syntactically-valid n8n target: connection refused instantly
// (nothing listens on port 1), so the route fails fast at the n8n
// verification call without needing a full n8n mock — the property under
// test is the concurrency guard, not a successful n8n workflow creation.
const connectBody = JSON.stringify({ n8nUrl: 'https://127.0.0.1:1/', n8nApiKey: 'test-key' });

function rawPostDripFed(path, cookie, body, { delayMs }) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(body, 'utf8');
    const mid = Math.floor(bytes.length / 2);
    const chunks = [bytes.subarray(0, mid), bytes.subarray(mid)];
    const socket = net.connect(port, '127.0.0.1', () => {
      const head = [
        `POST ${path} HTTP/1.1`,
        `Host: 127.0.0.1`,
        `Content-Type: application/json`,
        `Content-Length: ${bytes.length}`,
        `Cookie: ${cookie}`,
        `Connection: close`,
        '', '',
      ].join('\r\n');
      socket.write(head);
      socket.write(chunks[0]);
      setTimeout(() => socket.write(chunks[1]), delayMs);
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

test('concurrent /n8n/connect requests for the same account: only one proceeds, the other is rejected with 409', async () => {
  const accountId = 'race-test-account';
  const path = `/api/app/accounts/${accountId}/n8n/connect`;

  // Request A: body arrives in two halves 250ms apart, so the route is still
  // inside `readBody` (holding no lock yet) and then inside the locked
  // section while request B arrives.
  const slowRequest = rawPostDripFed(path, sessionCookie, connectBody, { delayMs: 250 });

  // Give request A time to open its connection and send the first half of
  // its body (and, once readBody resolves, to acquire the lock) before firing B.
  await new Promise(resolve => setTimeout(resolve, 100));

  const fastResponse = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: connectBody,
  });
  const fastBody = await fastResponse.json();

  assert.equal(fastResponse.status, 409);
  assert.match(fastBody.message, /already in progress/i);

  const slowResult = await slowRequest;
  assert.notEqual(slowResult.status, 409, 'the request holding the lock must not itself be rejected by it');

  // The lock must be released once the first attempt finishes (regardless of
  // its own outcome — here it fails with 400 because n8n is unreachable).
  const afterResponse = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: connectBody,
  });
  const afterBody = await afterResponse.json();
  assert.notEqual(afterResponse.status, 409);
  assert.doesNotMatch(afterBody.message || '', /already in progress/i);
});
