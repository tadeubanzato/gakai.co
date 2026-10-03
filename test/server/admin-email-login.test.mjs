import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-admin-email-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server } = await import('../../server.mjs');
after(() => server.close());
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const PASSWORD = 'a-long-enough-password';

const json = (body, cookie) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const setup = await fetch(`${base}/api/app/auth/setup`, json({ username: 'email-admin', password: PASSWORD }));
const cookie = setup.headers.get('set-cookie').split(';')[0];
const patch = body => fetch(`${base}/api/app/auth/profile`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ currentPassword: PASSWORD, ...body }) });
const login = username => fetch(`${base}/api/app/auth/login`, json({ username, password: PASSWORD }));

test('a new administrator has no email, and only the username signs in', async () => {
  const profile = await (await fetch(`${base}/api/app/auth/profile`, { headers: { cookie } })).json();
  assert.deepEqual(profile, { username: 'email-admin', email: null });
  assert.equal((await login('email-admin')).status, 200);
  assert.equal((await login('tadeu@example.com')).status, 401);
});

test('saving an email stores it lowercased and lets the administrator sign in with it, in any case', async () => {
  const response = await patch({ username: 'email-admin', email: '  Tadeu@Example.COM ' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email, 'tadeu@example.com');
  assert.equal((await (await fetch(`${base}/api/app/auth/profile`, { headers: { cookie } })).json()).email, 'tadeu@example.com');
  assert.equal((await login('tadeu@example.com')).status, 200);
  assert.equal((await login('TADEU@example.com')).status, 200);
  assert.equal((await login('email-admin')).status, 200, 'the username still works');
});

test('the wrong email or the right email with the wrong password is refused', async () => {
  assert.equal((await login('someone@example.com')).status, 401);
  const wrongPassword = await fetch(`${base}/api/app/auth/login`, json({ username: 'tadeu@example.com', password: 'not-the-password' }));
  assert.equal(wrongPassword.status, 401);
});

test('an invalid email is rejected and nothing changes', async () => {
  const response = await patch({ username: 'email-admin', email: 'not-an-email' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /valid email/i);
  assert.equal((await login('tadeu@example.com')).status, 200, 'the saved email is untouched');
});

test('a profile save that leaves email out keeps the saved email', async () => {
  assert.equal((await patch({ username: 'email-admin' })).status, 200);
  assert.equal((await login('tadeu@example.com')).status, 200);
});

test('clearing the email stops it working for sign-in', async () => {
  const response = await patch({ username: 'email-admin', email: '' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email, null);
  assert.equal((await login('tadeu@example.com')).status, 401);
  assert.equal((await login('email-admin')).status, 200);
});

test('username and email save without any password, and a new password still takes the current one', async () => {
  const noPassword = await fetch(`${base}/api/app/auth/profile`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ username: 'renamed-admin', email: 'renamed@example.com' }) });
  assert.equal(noPassword.status, 200, 'no password is needed to change the username or email');
  assert.deepEqual(await noPassword.json(), { ok: true, username: 'renamed-admin', email: 'renamed@example.com' });
  assert.equal((await login('renamed-admin')).status, 200);
  assert.equal((await login('renamed@example.com')).status, 200);
  assert.equal((await login('email-admin')).status, 401, 'the old username no longer signs in');

  const newPasswordAlone = await fetch(`${base}/api/app/auth/profile`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ newPassword: 'a-brand-new-password' }) });
  assert.equal(newPasswordAlone.status, 401, 'a new password without the current one is refused');
  const wrongCurrent = await fetch(`${base}/api/app/auth/profile`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ currentPassword: 'wrong-password-here', newPassword: 'a-brand-new-password' }) });
  assert.equal(wrongCurrent.status, 401);
  assert.equal((await login('renamed-admin')).status, 200, 'the password was not changed');
});
