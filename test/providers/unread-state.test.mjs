import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/providers/baileys/store.mjs';

// The read/unread lifecycle at the storage layer: a per-conversation read cursor plus a flag on each
// message, with the visible count derived from the flags. Each test names the acceptance scenario.
const ACCT = 'acct-1';
const CHAT = '5511999777057@s.whatsapp.net';
const fresh = () => openStore(new DatabaseSync(':memory:'));
const msg = (id, ts, { fromMe = false, source = 'live', body = id, chat = CHAT } = {}) => ({
  chatId: chat, messageId: id, timestamp: ts, fromMe, source,
  waMessage: { key: { id, remoteJid: chat, fromMe } },
  overviewMessage: { body, text: body, timestamp: ts, hasMedia: false, system: null },
});
const unread = (store, chat = CHAT) => store.getChatsOverview(ACCT).find(item => item.id === chat)?.unreadCount ?? 0;

test('1-2 one or several incoming messages count, once each', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100)]);
  assert.equal(unread(store), 1);
  store.upsertMessages(ACCT, [msg('b', 101), msg('c', 102)]);
  assert.equal(unread(store), 3);
  assert.equal(store.hasUnread(ACCT), true);
});

test('3 reading clears the count and it stays cleared', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100), msg('b', 101)]);
  assert.equal(store.markChatRead(ACCT, CHAT, 101), 0);
  assert.equal(unread(store), 0);
  assert.equal(store.hasUnread(ACCT), false);
});

test('4-5 chat events that carry a count never change it (the resurrection bug)', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100)]);
  store.markChatRead(ACCT, CHAT, 100);
  // Baileys reports a delta of +1, an old absolute 5, -1 ("marked unread"), or nothing at all.
  for (const unreadCount of [1, 5, -1, 0, undefined]) store.upsertChats(ACCT, [{ id: CHAT, name: 'Ana', unreadCount, conversationTimestamp: 100 }]);
  assert.equal(unread(store), 0);
  // And the other way: a metadata-only update must not erase real unread messages.
  store.upsertMessages(ACCT, [msg('b', 101)]);
  store.upsertChats(ACCT, [{ id: CHAT, pinned: true }]);
  assert.equal(unread(store), 1);
});

test('6 a new message after reading is unread again, others stay read', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100)]);
  store.markChatRead(ACCT, CHAT, 100);
  store.upsertMessages(ACCT, [msg('b', 101)]);
  assert.equal(unread(store), 1);
});

test('7-8 outgoing messages never count, including ones sent from the phone', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('mine', 100, { fromMe: true }), msg('phone', 101, { fromMe: true, source: 'live' })]);
  assert.equal(unread(store), 0);
});

test('9-10 history sync and reconnect replays never create unread', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('old1', 50, { source: 'history' }), msg('old2', 60, { source: 'history' })]);
  assert.equal(unread(store), 0, 'history is old by definition');
  store.upsertMessages(ACCT, [msg('a', 100)]);
  store.markChatRead(ACCT, CHAT, 100);
  // After a reconnect WhatsApp re-delivers messages the owner already read — live or appended.
  store.upsertMessages(ACCT, [msg('a', 100), msg('old1', 50)]);
  store.upsertMessages(ACCT, [msg('a', 100, { source: 'history' })]);
  assert.equal(unread(store), 0);
});

test('11 a duplicate event never counts twice', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100)]);
  store.upsertMessages(ACCT, [msg('a', 100)]);
  store.upsertMessages(ACCT, [msg('a', 100, { body: 'a (edited)' })]);
  assert.equal(unread(store), 1);
});

test('the read cursor is monotonic: a late, older read cannot un-read or be undone', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100), msg('b', 200)]);
  store.markChatRead(ACCT, CHAT, 200);
  store.markChatRead(ACCT, CHAT, 100);                    // a stale, out-of-order request
  assert.equal(unread(store), 0);
  // A message that was delayed in transit but is older than the cursor is already read.
  store.upsertMessages(ACCT, [msg('late', 150)]);
  assert.equal(unread(store), 0);
});

test('12-13 reading up to a point leaves later messages unread (scrolled-up reader)', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100), msg('b', 101), msg('c', 102)]);
  assert.equal(store.markChatRead(ACCT, CHAT, 101), 1);
  assert.equal(unread(store), 1);
  assert.equal(store.markChatRead(ACCT, CHAT, 102), 0);
});

test('16 messages arriving around a read are not lost: only those up to the boundary clear', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100)]);
  store.upsertMessages(ACCT, [msg('b', 101)]);            // lands while the read of `a` is in flight
  store.markChatRead(ACCT, CHAT, 100);
  assert.equal(unread(store), 1);
});

test('read on another device: a READ status clears that message and everything before it', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100), msg('b', 101), msg('c', 102)]);
  assert.equal(store.markMessagesReadElsewhere(ACCT, CHAT, ['b']), 1);
  assert.equal(store.markMessagesReadElsewhere(ACCT, CHAT, ['nope']), null);
  assert.equal(unread(store), 1);
});

test('read receipts are sent only for messages that are still unread', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100), msg('b', 101), msg('mine', 102, { fromMe: true })]);
  assert.deepEqual(store.unreadIncomingKeys(ACCT, CHAT).map(key => key.id).sort(), ['a', 'b']);
  store.markChatRead(ACCT, CHAT, 101);
  assert.deepEqual(store.unreadIncomingKeys(ACCT, CHAT), [], 'nothing left to acknowledge, so no repeat receipt');
});

test('deleting a message removes it from the count', () => {
  const store = fresh();
  store.upsertMessages(ACCT, [msg('a', 100), msg('b', 101)]);
  store.deleteMessage(ACCT, CHAT, 'a');
  assert.equal(unread(store), 1);
});

test('18 merging a LID chat carries its unread messages and the later read cursor', () => {
  const store = fresh();
  const lid = '1379@lid';
  store.upsertMessages(ACCT, [msg('x', 100, { chat: lid }), msg('y', 101, { chat: lid })]);
  store.upsertMessages(ACCT, [msg('p', 90)]);
  store.markChatRead(ACCT, CHAT, 95);
  store.mergeChat(ACCT, lid, CHAT);
  assert.equal(unread(store), 2);
});

test('a database from before this model is upgraded: counts become flagged messages, read chats stay read', () => {
  const db = new DatabaseSync(':memory:');
  const legacy = openStore(db);
  // Simulate the old shape: drop the new columns' effect by writing old-style counters.
  legacy.upsertMessages(ACCT, [msg('a', 100, { source: 'history' }), msg('b', 101, { source: 'history' }), msg('c', 102, { source: 'history' })]);
  db.prepare(`UPDATE wa_chats SET unread_count=2 WHERE chat_id=?`).run(CHAT);
  db.exec(`UPDATE wa_chats SET read_ts=0; UPDATE wa_messages SET unread=0`);
  // Re-opening an already-migrated database must not re-run the backfill.
  assert.equal(openStore(db).getChatsOverview(ACCT)[0].unreadCount, 0);
  // A pre-model database has no read_ts column, so the migration runs.
  db.exec(`ALTER TABLE wa_chats DROP COLUMN read_ts`);
  const upgraded = openStore(db);
  const [chat] = upgraded.getChatsOverview(ACCT);
  assert.equal(chat.unreadCount, 2, 'the newest two incoming messages become the unread ones');
  upgraded.markChatRead(ACCT, CHAT, 102);
  assert.equal(openStore(db).getChatsOverview(ACCT)[0].unreadCount, 0, 'and reading sticks across restarts');
});
