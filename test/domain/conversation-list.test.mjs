import assert from 'node:assert/strict';
import test from 'node:test';
import { pageConversations, encodeCursor, decodeCursor, clampPageSize } from '../../src/domain/conversation-list.mjs';

const chat = (n, timestamp, extra = {}) => ({ id: `${1000 + n}@s.whatsapp.net`, lastMessageTimestamp: timestamp, lastMessage: { body: 'hi', text: 'hi', timestamp, hasMedia: false, system: null }, ...extra });

test('cursor round-trips and rejects junk', () => {
  assert.deepEqual(decodeCursor(encodeCursor(123, 'a@s.whatsapp.net')), { timestamp: 123, id: 'a@s.whatsapp.net' });
  for (const bad of [undefined, '', 'nope', Buffer.from('[1]').toString('base64url'), Buffer.from('{}').toString('base64url')]) assert.equal(decodeCursor(bad), null);
});

test('clampPageSize defaults to 50 and caps at 200', () => {
  assert.equal(clampPageSize(undefined), 50);
  assert.equal(clampPageSize('abc'), 50);
  assert.equal(clampPageSize(-3), 50);
  assert.equal(clampPageSize(7), 7);
  assert.equal(clampPageSize(100000), 200);
});

test('pages walk the whole list newest-first with no gaps or repeats, even across timestamp ties', () => {
  const chats = Array.from({ length: 23 }, (_, n) => chat(n, 1000 - Math.floor(n / 3)));
  const seen = [];
  let cursor;
  do {
    const page = pageConversations(chats, { limit: 5, cursor });
    assert.ok(page.chats.length <= 5);
    seen.push(...page.chats.map(c => c.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 23);
  assert.equal(seen.length, 23);
});

test('hidden kinds never use up a slot: the page is `limit` listable chats', () => {
  const chats = [
    { id: 'status@broadcast', lastMessageTimestamp: 9999, lastMessage: { body: 'x', text: 'x', timestamp: 9999 } },
    { id: '1700000000@broadcast', lastMessageTimestamp: 9998, lastMessage: { body: 'x', text: 'x', timestamp: 9998 } },
    ...Array.from({ length: 4 }, (_, n) => chat(n, 100 - n)),
  ];
  const page = pageConversations(chats, { limit: 3 });
  assert.equal(page.chats.length, 3);
  assert.ok(page.chats.every(c => c.id.endsWith('@s.whatsapp.net')));
  assert.ok(page.nextCursor);
});

test('the last page has no cursor', () => {
  assert.equal(pageConversations([chat(1, 5), chat(2, 4)], { limit: 2 }).nextCursor, null);
});

test('pinned chats open the first page only, then the unpinned run continues without repeating them', () => {
  const chats = [chat(1, 10, { pinned: true }), chat(2, 90), chat(3, 80), chat(4, 70), chat(5, 60)];
  const first = pageConversations(chats, { limit: 2 });
  assert.deepEqual(first.chats.map(c => c.id), [chats[0].id, chats[1].id, chats[2].id]);
  const second = pageConversations(chats, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.chats.map(c => c.id), [chats[3].id, chats[4].id]);
  assert.equal(second.nextCursor, null);
});
