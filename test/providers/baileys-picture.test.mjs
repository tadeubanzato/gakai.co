import assert from 'node:assert/strict';
import test from 'node:test';
import { pictureUrlExpired, freshPictureUrl } from '../../src/providers/baileys/picture.mjs';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const linkExpiringAt = ms => `https://pps.whatsapp.net/v/t61.24694-24/1_2_n.jpg?ccb=11-4&oh=abc&oe=${Math.floor(ms / 1000).toString(16).toUpperCase()}&_nc_sid=5e03e0`;
const DAY = 24 * 60 * 60 * 1000;

test('a picture link past its oe expiry is expired', () => {
  assert.equal(pictureUrlExpired(linkExpiringAt(NOW - 27 * DAY), NOW), true);
  assert.equal(freshPictureUrl(linkExpiringAt(NOW - 27 * DAY), NOW), null);
});

test('a picture link with time left is kept as-is', () => {
  const link = linkExpiringAt(NOW + 10 * DAY);
  assert.equal(pictureUrlExpired(link, NOW), false);
  assert.equal(freshPictureUrl(link, NOW), link);
});

test('a link about to expire is treated as expired, so the browser never gets one that dies in transit', () => {
  assert.equal(pictureUrlExpired(linkExpiringAt(NOW + 10 * 60 * 1000), NOW), true);
});

test('a value with no readable expiry is never judged expired', () => {
  assert.equal(pictureUrlExpired('https://example.com/avatar.jpg', NOW), false);
  assert.equal(pictureUrlExpired('data:image/jpeg;base64,AAAA', NOW), false);
  assert.equal(pictureUrlExpired('not a url', NOW), false);
  assert.equal(freshPictureUrl('https://example.com/avatar.jpg', NOW), 'https://example.com/avatar.jpg');
});

test('a missing picture stays missing', () => {
  assert.equal(pictureUrlExpired(null, NOW), false);
  assert.equal(freshPictureUrl(null, NOW), null);
  assert.equal(freshPictureUrl('', NOW), null);
});

// --- background refresher ---
const { createPictureRefresher } = await import('../../src/providers/baileys/picture.mjs');

function refresherFor(pictures, { missing = new Set(), lookaheadMs = 0 } = {}) {
  const asked = [];
  const refresher = createPictureRefresher({
    listChatIds: () => Object.keys(pictures),
    getStoredPicture: (accountId, chatId) => pictures[chatId],
    isKnownMissing: (accountId, chatId) => missing.has(chatId),
    refresh: async (accountId, chatId) => { asked.push(chatId); return chatId === 'none@s.whatsapp.net' ? null : 'https://pps.whatsapp.net/new.jpg'; },
    lookaheadMs,
    sleep: async () => {},
  });
  return { refresher, asked };
}

test('a sweep re-asks only for missing or expired pictures', async () => {
  const { refresher, asked } = refresherFor({
    'fresh@s.whatsapp.net': linkExpiringAt(Date.now() + 10 * DAY),
    'expired@s.whatsapp.net': linkExpiringAt(Date.now() - 27 * DAY),
    'never@s.whatsapp.net': null,
  });
  const result = await refresher.sweep('acct');
  assert.deepEqual(asked, ['expired@s.whatsapp.net', 'never@s.whatsapp.net']);
  assert.deepEqual(result, { skipped: false, checked: 2, refreshed: 2 });
});

test('a sweep renews a picture that would expire before the next sweep', async () => {
  const { refresher, asked } = refresherFor({ 'soon@s.whatsapp.net': linkExpiringAt(Date.now() + 3 * 60 * 60 * 1000) }, { lookaheadMs: 6 * 60 * 60 * 1000 });
  await refresher.sweep('acct');
  assert.deepEqual(asked, ['soon@s.whatsapp.net']);
});

test('a chat recently found to have no picture is left alone', async () => {
  const { refresher, asked } = refresherFor({ 'none@s.whatsapp.net': null }, { missing: new Set(['none@s.whatsapp.net']) });
  const result = await refresher.sweep('acct');
  assert.deepEqual(asked, []);
  assert.equal(result.checked, 0);
});

test('a lookup that finds no picture is counted as checked, not refreshed', async () => {
  const { refresher } = refresherFor({ 'none@s.whatsapp.net': null });
  assert.deepEqual(await refresher.sweep('acct'), { skipped: false, checked: 1, refreshed: 0 });
});

test('a sweep stops as soon as the account is no longer active', async () => {
  const { refresher, asked } = refresherFor({ 'a@s.whatsapp.net': null, 'b@s.whatsapp.net': null, 'c@s.whatsapp.net': null });
  await refresher.sweep('acct', { isActive: () => asked.length < 1 });
  assert.deepEqual(asked, ['a@s.whatsapp.net']);
});

test('a second sweep for the same account does not overlap the first', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const refresher = createPictureRefresher({
    listChatIds: () => ['a@s.whatsapp.net'], getStoredPicture: () => null, isKnownMissing: () => false,
    refresh: async () => { await gate; return null; }, sleep: async () => {},
  });
  const first = refresher.sweep('acct');
  assert.equal((await refresher.sweep('acct')).skipped, true);
  release();
  assert.equal((await first).skipped, false);
});
