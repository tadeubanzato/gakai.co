import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Math.floor(Date.now() / 1000);
const day = 24 * 60 * 60;
const accountId = 'recency-account';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-inbox-recency-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

// Fixed set of chats: a mix of recent, stale (older than the 60-day default
// recency window), and one that gets deleted through Gakai.
provider.__test.seedAccount(accountId);
const seed = (id, name, lastMessage) => provider.__test.seedChat(accountId, { id, name, lastMessage: { text: lastMessage.body || '', system: null, ...lastMessage } });
seed('recent-1@s.whatsapp.net', 'Recent 1', { timestamp: now - 1 * day, body: 'hi', hasMedia: false });
seed('recent-2@s.whatsapp.net', 'Recent 2', { timestamp: now - 5 * day, body: 'hey', hasMedia: false });
seed('stale-1@s.whatsapp.net', 'Stale 1', { timestamp: now - 120 * day, body: 'old', hasMedia: false });
seed('stale-2@s.whatsapp.net', 'Stale 2', { timestamp: now - 400 * day, body: 'older', hasMedia: false });
seed('deleted-in-gakai@s.whatsapp.net', 'Deleted in Gakai', { timestamp: now - 2 * day, body: 'gone', hasMedia: false });
// A resync "ghost": fresh timestamp, but no real message behind it.
seed('ghost@lid', 'Ghost Contact', { timestamp: now, body: '', hasMedia: false });
// A real recent conversation whose latest activity was a voice call, not a
// text/media message — unlike the ghost above, this has a genuine, typed
// event behind it and must still show up in the inbox.
seed('call-only@s.whatsapp.net', 'Call Only', { timestamp: now - 3 * day, body: '', hasMedia: false, system: { kind: 'call', label: 'Missed voice call' } });
// Observed live: a contact with zero real message history, surfaced purely
// by a fresh-looking encryption-handshake notice (the same resync-touch
// behavior as the plain ghost above, just with a real system event on it).
// This must be excluded exactly like the untyped ghost — a real system
// event alone isn't enough; only an actual call counts.
seed('e2e-only@lid', 'Unknown user', { timestamp: now, body: '', hasMedia: false, system: { kind: 'security', label: 'Messages are end-to-end encrypted' } });

await provider.deleteChat(accountId, 'deleted-in-gakai@s.whatsapp.net');

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'recency-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('the inbox excludes chats with no activity in the recency window, even when fewer chats exist than the cap', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, { headers: { cookie } });
  const chats = await response.json();

  assert.equal(response.status, 200);
  const ids = chats.map(c => c.id).sort();
  assert.deepEqual(ids, ['call-only@s.whatsapp.net', 'recent-1@s.whatsapp.net', 'recent-2@s.whatsapp.net'], 'stale chats, the deleted chat, the fresh-timestamp-no-content ghost, and a fabricated encryption-notice-only contact must not pad out the list, but a real recent call must still show');
});

test('the most recently active chat sorts first', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, { headers: { cookie } });
  const chats = await response.json();
  assert.equal(chats[0].id, 'recent-1@s.whatsapp.net'); // 1 day ago, more recent than recent-2's 5 days ago
});
