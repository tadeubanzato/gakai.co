import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-session-revoke-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server } = await import('../../server.mjs');
after(() => server.close());

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

test('changing the password revokes every other session but keeps the changing tab signed in', async () => {
  const setup = await fetch(`${base}/api/app/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'revoke-admin', password: 'the-first-password' }),
  });
  const firstTabCookie = setup.headers.get('set-cookie').split(';')[0];

  // A second "device"/tab logs in with the same credentials.
  const secondLogin = await fetch(`${base}/api/app/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'revoke-admin', password: 'the-first-password' }),
  });
  const secondTabCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  assert.notEqual(firstTabCookie, secondTabCookie);

  // Confirm both sessions are valid before the password change.
  const beforeFirst = await fetch(`${base}/api/app/auth/profile`, { headers: { cookie: firstTabCookie } });
  const beforeSecond = await fetch(`${base}/api/app/auth/profile`, { headers: { cookie: secondTabCookie } });
  assert.equal(beforeFirst.status, 200);
  assert.equal(beforeSecond.status, 200);

  const changePassword = await fetch(`${base}/api/app/auth/profile`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: firstTabCookie },
    body: JSON.stringify({ currentPassword: 'the-first-password', newPassword: 'the-second-password-here' }),
  });
  assert.equal(changePassword.status, 200);
  const reissuedCookie = changePassword.headers.get('set-cookie')?.split(';')[0];
  assert.ok(reissuedCookie, 'the tab that changed the password must receive a fresh session cookie');

  // The tab that changed the password stays signed in on its new cookie.
  const afterFirst = await fetch(`${base}/api/app/auth/profile`, { headers: { cookie: reissuedCookie } });
  assert.equal(afterFirst.status, 200);

  // The second tab's old session must now be rejected.
  const afterSecond = await fetch(`${base}/api/app/auth/profile`, { headers: { cookie: secondTabCookie } });
  assert.equal(afterSecond.status, 401, 'a leaked/second session must not survive a password change');

  // The first tab's pre-change cookie (now superseded) must also be rejected.
  const afterFirstOldCookie = await fetch(`${base}/api/app/auth/profile`, { headers: { cookie: firstTabCookie } });
  assert.equal(afterFirstOldCookie.status, 401);
});
