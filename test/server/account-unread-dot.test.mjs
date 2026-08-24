import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Math.floor(Date.now() / 1000);

const scratch = await mkdtemp(join(tmpdir(), 'gakai-account-unread-dot-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

// Three accounts, each with a different chat-overview shape, to exercise the
// sidebar unread dot's three real cases: a genuine unread text message, a
// chat marked unread but whose only content is a fabricated system-event
// touch (must not count), and a fully-read account (must not count either).
provider.__test.seedAccount('has-real-unread');
provider.__test.seedChat('has-real-unread', { id: 'a@s.whatsapp.net', name: 'Real Unread', unreadCount: 2, lastMessage: { timestamp: now, body: 'hey are you there', text: 'hey are you there', hasMedia: false, system: null } });

provider.__test.seedAccount('has-fabricated-unread-only');
// Mirrors what was observed live: a resync-touched encryption notice can
// carry a nonzero unreadCount even though no real message exists — the dot
// must not light up for this.
provider.__test.seedChat('has-fabricated-unread-only', { id: 'b@lid', name: 'Unknown user', unreadCount: 1, lastMessage: { timestamp: now, body: '', text: '', hasMedia: false, system: { kind: 'security', label: 'Messages are end-to-end encrypted' } } });

provider.__test.seedAccount('has-no-unread');
provider.__test.seedChat('has-no-unread', { id: 'c@s.whatsapp.net', name: 'All Read', unreadCount: 0, lastMessage: { timestamp: now, body: 'already seen', text: 'already seen', hasMedia: false, system: null } });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'unread-dot-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('the sidebar unread dot reflects a genuine unread message, ignores a fabricated system-event touch, and is off with nothing unread', async () => {
  const response = await fetch(`${base}/api/app/accounts`, { headers: { cookie } });
  const { accounts } = await response.json();

  assert.equal(response.status, 200);
  const byId = Object.fromEntries(accounts.map(item => [item.id, item]));
  assert.equal(byId['has-real-unread'].hasUnread, true);
  assert.equal(byId['has-fabricated-unread-only'].hasUnread, false);
  assert.equal(byId['has-no-unread'].hasUnread, false);
});
