import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-preferences-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server } = await import('../../server.mjs');
after(() => server.close());
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'prefs-admin', password: 'a-long-enough-password' }) });
const cookie = setup.headers.get('set-cookie').split(';')[0];
const get = headers => fetch(`${base}/api/app/preferences`, { headers });
const patch = (body, headers = { cookie }) => fetch(`${base}/api/app/preferences`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('preferences require a signed-in administrator', async () => {
  assert.equal((await get({})).status, 401);
  assert.equal((await patch({ sidebarCollapsed: true }, {})).status, 401);
});

test('the menu state starts unset, then remembers collapsed and expanded', async () => {
  assert.deepEqual(await (await get({ cookie })).json(), { sidebarCollapsed: null });
  assert.deepEqual(await (await patch({ sidebarCollapsed: true })).json(), { sidebarCollapsed: true });
  assert.deepEqual(await (await get({ cookie })).json(), { sidebarCollapsed: true });
  assert.deepEqual(await (await patch({ sidebarCollapsed: false })).json(), { sidebarCollapsed: false });
  assert.deepEqual(await (await get({ cookie })).json(), { sidebarCollapsed: false });
});

test('the saved menu state survives signing out and back in', async () => {
  await patch({ sidebarCollapsed: true });
  const signIn = async () => {
    const login = await fetch(`${base}/api/app/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'prefs-admin', password: 'a-long-enough-password' }) });
    return login.headers.get('set-cookie').split(';')[0];
  };
  const firstSession = await signIn(); // its own session, so signing out leaves the shared one alone
  await fetch(`${base}/api/app/auth/logout`, { method: 'POST', headers: { cookie: firstSession } });
  assert.equal((await get({ cookie: firstSession })).status, 401, 'signed out');
  assert.deepEqual(await (await get({ cookie: await signIn() })).json(), { sidebarCollapsed: true });
});

test('only a true or false is accepted, and an unrelated key stores nothing', async () => {
  assert.equal((await patch({ sidebarCollapsed: 'yes' })).status, 400);
  assert.equal((await patch({ sidebarCollapsed: 1 })).status, 400);
  const before = await (await get({ cookie })).json();
  const response = await patch({ somethingElse: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), before);
});
