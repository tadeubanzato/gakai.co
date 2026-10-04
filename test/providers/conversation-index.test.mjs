import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/providers/baileys/store.mjs';
import { hasMessageContent } from '../../src/domain/message.mjs';

const A = 'acct';
const jid = n => `${15550000000 + n}@s.whatsapp.net`;
const fresh = () => openStore(new DatabaseSync(':memory:'));
const preview = (timestamp, extra = {}) => ({ body: 'hi', text: 'hi', timestamp, hasMedia: false, system: null, ...extra });
const message = (chatId, id, timestamp, over = {}) => ({
  chatId, messageId: id, timestamp, fromMe: false, source: 'history',
  waMessage: { key: { id, remoteJid: chatId }, messageTimestamp: timestamp }, overviewMessage: preview(timestamp), ...over,
});
const seed = (store, count) => store.upsertMessages(A, Array.from({ length: count }, (_, n) => message(jid(n), `m${n}`, 1000 + n)));
const ids = page => page.chats.map(chat => chat.id);

test('first page is the latest `limit` conversations, newest first, from any number stored', () => {
  const store = fresh();
  seed(store, 120);
  const page = store.listChatsPage(A, { limit: 50 });
  assert.equal(page.chats.length, 50);
  assert.equal(page.chats[0].id, jid(119));
  assert.equal(page.chats[49].id, jid(70));
  assert.ok(page.nextCursor);
});

test('the cursor continues exactly where the page ended: no gaps, no repeats, then none left', () => {
  const store = fresh();
  seed(store, 120);
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = store.listChatsPage(A, { limit: 50, cursor });
    seen.push(...ids(page));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.deepEqual(seen, [...seen].sort((a, b) => b.localeCompare(a, 'en', { numeric: true })), 'strictly newest first');
});

test('conversations sharing a timestamp are paged exactly, with the id as tiebreak', () => {
  const store = fresh();
  store.upsertMessages(A, Array.from({ length: 7 }, (_, n) => message(jid(n), `m${n}`, 500)));
  const first = store.listChatsPage(A, { limit: 3 });
  const second = store.listChatsPage(A, { limit: 3, cursor: first.nextCursor });
  const third = store.listChatsPage(A, { limit: 3, cursor: second.nextCursor });
  assert.equal(new Set([...ids(first), ...ids(second), ...ids(third)]).size, 7);
  assert.equal(third.nextCursor, null);
});

test('status, broadcast lists and channels are never stored as conversations and never listed', () => {
  const store = fresh();
  store.upsertChats(A, [{ id: 'status@broadcast', conversationTimestamp: 9999 }, { id: '1700@broadcast' }, { id: '1@newsletter' }]);
  store.upsertMessages(A, [message('status@broadcast', 's1', 9999), message('1700@broadcast', 'b1', 9998), message('1@newsletter', 'n1', 9997), message(jid(1), 'real', 10)]);
  assert.deepEqual(ids(store.listChatsPage(A, {})), [jid(1)]);
  assert.deepEqual(store.listChatIds(A), [jid(1)]);
  assert.equal(store.getMessageById(A, 'status@broadcast', 's1'), null);
});

test('rows that already exist for hidden kinds (older databases) are filtered out of every list', () => {
  const db = new DatabaseSync(':memory:');
  const store = openStore(db);
  store.upsertMessages(A, [message(jid(1), 'real', 10)]);
  const json = JSON.stringify(preview(9999));
  db.prepare(`INSERT INTO wa_chats(account_id, chat_id, unread_count, last_message_timestamp, last_message_json, updated_at) VALUES (?,?,0,9999,?,?)`).run(A, 'status@broadcast', json, 'x');
  db.prepare(`INSERT INTO wa_messages(account_id, chat_id, message_id, timestamp, from_me, payload_json, created_at, unread) VALUES (?,?,?,?,0,'{}','x',1)`).run(A, 'status@broadcast', 'old', 9999);
  assert.deepEqual(ids(store.listChatsPage(A, {})), [jid(1)]);
  assert.deepEqual(store.getChatsOverview(A).map(chat => chat.id), [jid(1)]);
  assert.equal(store.hasUnread(A), false, 'a stored status update must not light the unread dot');
});

test('filtering happens before the limit: hidden and contentless chats do not use up slots', () => {
  const store = fresh();
  store.upsertChats(A, Array.from({ length: 10 }, (_, n) => ({ id: jid(100 + n), conversationTimestamp: 5000 + n }))); // ghosts: newer, but no message behind them
  seed(store, 4);
  const page = store.listChatsPage(A, { limit: 3 });
  assert.deepEqual(ids(page), [jid(3), jid(2), jid(1)]);
  assert.ok(page.nextCursor);
});

test('the SQL content rule matches hasMessageContent for every preview shape', () => {
  const shapes = [
    preview(1, { body: '', text: '' }), preview(1), preview(1, { body: '', text: 'only text' }), preview(1, { body: '', text: '', hasMedia: true }),
    preview(1, { body: '', text: '', system: { kind: 'call', label: 'Missed' } }), preview(1, { body: '', text: '', system: { kind: 'security' } }),
  ];
  shapes.forEach((shape, n) => {
    const store = fresh();
    store.upsertMessages(A, [message(jid(n), 'm', 1, { overviewMessage: shape })]);
    assert.equal(store.listChatsPage(A, {}).chats.length === 1, hasMessageContent({ lastMessage: shape }), JSON.stringify(shape));
  });
});

test('a chat first seen from chat sync with a too-new timestamp still gets its preview from its first real message', () => {
  const store = fresh();
  store.upsertChats(A, [{ id: jid(1), conversationTimestamp: 9000 }]);
  assert.equal(store.listChatsPage(A, {}).chats.length, 0);
  store.upsertMessages(A, [message(jid(1), 'm1', 4000)]);
  const [chat] = store.listChatsPage(A, {}).chats;
  assert.equal(chat.lastMessage.body, 'hi');
});

test('a new message moves its conversation to the top; a stale history replay does not', () => {
  const store = fresh();
  seed(store, 40);
  store.upsertMessages(A, [message(jid(10), 'live', 5000, { source: 'live' })]);
  assert.equal(store.listChatsPage(A, {}).chats[0].id, jid(10));
  store.upsertMessages(A, [message(jid(10), 'ancient', 5, { source: 'history' })]);
  const [top] = store.listChatsPage(A, {}).chats;
  assert.equal(top.id, jid(10));
  assert.equal(top.lastMessageTimestamp, 5000, 'old history never rewinds the conversation');
});

test('a delivery/read receipt re-saves a message but does not move the conversation', () => {
  const store = fresh();
  seed(store, 5);
  const before = ids(store.listChatsPage(A, {}));
  const raw = store.getMessageById(A, jid(1), 'm1');
  store.upsertMessages(A, [{ ...message(jid(1), 'm1', 1001), fromMe: true, waMessage: { ...raw, status: 4 }, source: 'live' }]);
  assert.deepEqual(ids(store.listChatsPage(A, {})), before);
});

test('replaying the same history twice changes nothing: no duplicates, no extra unread', () => {
  const store = fresh();
  const batch = Array.from({ length: 30 }, (_, n) => message(jid(n % 10), `m${n}`, 1000 + n));
  store.upsertChats(A, Array.from({ length: 10 }, (_, n) => ({ id: jid(n), name: `Chat ${n}`, conversationTimestamp: 1000 + n })));
  store.upsertMessages(A, batch);
  const snapshot = JSON.stringify([store.listChatsPage(A, {}), store.getMessagesPage(A, jid(3), { limit: 100 })]);
  store.upsertChats(A, Array.from({ length: 10 }, (_, n) => ({ id: jid(n), name: `Chat ${n}`, conversationTimestamp: 1000 + n })));
  store.upsertMessages(A, batch);
  assert.equal(JSON.stringify([store.listChatsPage(A, {}), store.getMessagesPage(A, jid(3), { limit: 100 })]), snapshot);
  assert.equal(store.hasUnread(A), false, 'history never creates unread');
});

test('archived chats are paged separately', () => {
  const store = fresh();
  seed(store, 6);
  store.setChatFlags(A, jid(2), { archived: true });
  assert.equal(ids(store.listChatsPage(A, {})).includes(jid(2)), false);
  assert.deepEqual(ids(store.listChatsPage(A, { archived: true })), [jid(2)]);
});

test('contact names are kept apart, and an empty update never erases a known name', () => {
  const store = fresh();
  store.upsertContacts(A, [{ id: jid(1), name: 'Saved', pushName: 'Pushy', verifiedName: null }]);
  store.upsertContacts(A, [{ id: jid(1), name: null, pushName: null }]);
  const row = store.getContactsForChats(A, [jid(1)]).get(jid(1)).contacts[0];
  assert.equal(row.name, 'Saved');
  assert.equal(row.push_name, 'Pushy');
  store.upsertContacts(A, [{ id: jid(2), notify: 'Only Push' }]);
  assert.equal(store.getContact(A, jid(2)).name, 'Only Push', 'other consumers still get a best-available name');
  assert.equal(store.getContactsForChats(A, [jid(2)]).get(jid(2)).contacts[0].name, null, 'but the identity layer sees it is only a push name');
});

test('a name stored under a LID reaches the phone-number conversation, and the other way round', () => {
  const store = fresh();
  const lid = '555123@lid';
  store.setLidMapping(A, lid, jid(1));
  store.upsertContacts(A, [{ id: lid, notify: 'Under Lid' }]);
  const forPn = store.getContactsForChats(A, [jid(1)]).get(jid(1));
  assert.deepEqual(forPn.contacts.map(row => row.push_name), ['Under Lid']);
  const forLid = store.getContactsForChats(A, [lid]).get(lid);
  assert.equal(forLid.phoneJid, jid(1));
});

test('getContactsForChats on an empty list does no work', () => {
  assert.equal(fresh().getContactsForChats(A, []).size, 0);
});

test('pinned chats lead the first page whatever their age, without using up the unpinned page', () => {
  const store = fresh();
  seed(store, 20);
  store.setChatFlags(A, jid(0), { pinned: true }); // the oldest chat of all
  store.setChatFlags(A, jid(1), { pinned: true });
  const first = store.listChatsPage(A, { limit: 5 });
  assert.deepEqual(ids(first), [jid(1), jid(0), jid(19), jid(18), jid(17), jid(16), jid(15)], 'pinned (newest first), then 5 unpinned');
  const second = store.listChatsPage(A, { limit: 5, cursor: first.nextCursor });
  assert.deepEqual(ids(second), [jid(14), jid(13), jid(12), jid(11), jid(10)], 'later pages continue the unpinned run, no pinned repeats');
});

test('a pinned chat with no real message behind it, or in another archive state, is still not listed', () => {
  const store = fresh();
  store.upsertChats(A, [{ id: jid(50), conversationTimestamp: 100 }]);
  store.setChatFlags(A, jid(50), { pinned: true });
  seed(store, 2);
  store.setChatFlags(A, jid(1), { pinned: true, archived: true });
  assert.deepEqual(ids(store.listChatsPage(A, {})), [jid(0)]);
});
