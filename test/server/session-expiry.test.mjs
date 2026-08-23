import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-session-expiry-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_SESSION_TTL_MS = '50'; // short-lived on purpose, to make expiry observable

const { server, sessions } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

test('a session expires after GAKAI_SESSION_TTL_MS and is rejected on the next authenticated request', async () => {
  const setup = await fetch(`${base}/api/app/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'expiry-admin', password: 'a-long-enough-password' }),
  });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  assert.equal(sessions.size, 1);

  const immediateProfile = await fetch(`${base}/api/app/auth/profile`, { headers: { cookie } });
  assert.equal(immediateProfile.status, 200, 'a freshly issued session must be valid immediately');

  await new Promise(resolve => setTimeout(resolve, 80));

  const expiredProfile = await fetch(`${base}/api/app/auth/profile`, { headers: { cookie } });
  assert.equal(expiredProfile.status, 401, 'a session older than the TTL must be rejected');
});

test('a "remember me" session outlives the short TTL (uses the 30-day remember window instead)', async () => {
  const login = await fetch(`${base}/api/app/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'expiry-admin', password: 'a-long-enough-password', remember: true }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  await new Promise(resolve => setTimeout(resolve, 80)); // longer than the 50ms non-remember TTL

  const stillValid = await fetch(`${base}/api/app/auth/profile`, { headers: { cookie } });
  assert.equal(stillValid.status, 200, 'a remember-me session must not expire under the short non-remember TTL');
});
