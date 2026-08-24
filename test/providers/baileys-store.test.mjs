import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/providers/baileys/store.mjs';

function freshStore() {
  return openStore(new DatabaseSync(':memory:'));
}

test('upsertMessages stores a message and bumps the chat\'s denormalized last-message snapshot', () => {
  const store = freshStore();
  store.upsertMessages('acct-1', [{
    chatId: 'chat-1', messageId: 'm1', timestamp: 100, fromMe: false,
    waMessage: { key: { id: 'm1' }, messageTimestamp: 100 },
    overviewMessage: { body: 'hi', text: 'hi', timestamp: 100, hasMedia: false, system: null },
  }]);

  const [chat] = store.getChatsOverview('acct-1');
  assert.equal(chat.id, 'chat-1');
  assert.equal(chat.lastMessageTimestamp, 100);
  assert.equal(chat.lastMessage.body, 'hi');
});

test('upsertMessages never regresses the last-message snapshot to an older message', () => {
  const store = freshStore();
  store.upsertMessages('acct-1', [{
    chatId: 'chat-1', messageId: 'newer', timestamp: 200, fromMe: false,
    waMessage: { key: { id: 'newer' } },
    overviewMessage: { body: 'second', text: 'second', timestamp: 200, hasMedia: false, system: null },
  }]);
  // A backfill/history-sync batch can deliver an older message after a newer
  // one is already cached — the chat's preview must stay on the newer one.
  store.upsertMessages('acct-1', [{
    chatId: 'chat-1', messageId: 'older', timestamp: 100, fromMe: false,
    waMessage: { key: { id: 'older' } },
    overviewMessage: { body: 'first', text: 'first', timestamp: 100, hasMedia: false, system: null },
  }]);

  const [chat] = store.getChatsOverview('acct-1');
  assert.equal(chat.lastMessage.body, 'second');
  assert.equal(chat.lastMessageTimestamp, 200);
});

test('getMessagesPage pages backward from a timestamp cursor, most recent first', () => {
  const store = freshStore();
  const rows = [1, 2, 3, 4, 5].map(n => ({
    chatId: 'chat-1', messageId: `m${n}`, timestamp: n * 10, fromMe: false,
    waMessage: { key: { id: `m${n}` }, n },
    overviewMessage: { body: `msg ${n}`, text: `msg ${n}`, timestamp: n * 10, hasMedia: false, system: null },
  }));
  store.upsertMessages('acct-1', rows);

  const firstPage = store.getMessagesPage('acct-1', 'chat-1', { limit: 2 });
  assert.deepEqual(firstPage.map(m => m.n), [5, 4]);

  const nextPage = store.getMessagesPage('acct-1', 'chat-1', { limit: 2, before: 40 });
  assert.deepEqual(nextPage.map(m => m.n), [3, 2]);
});

test('deleteMessage removes the message and any reactions on it', () => {
  const store = freshStore();
  store.upsertMessages('acct-1', [{
    chatId: 'chat-1', messageId: 'm1', timestamp: 10, fromMe: false,
    waMessage: { key: { id: 'm1' } },
    overviewMessage: { body: 'hi', text: 'hi', timestamp: 10, hasMedia: false, system: null },
  }]);
  store.applyReaction('acct-1', { targetMessageId: 'm1', senderId: 'them@s.whatsapp.net', reaction: '👍' });
  assert.equal(store.getReaction('acct-1', 'm1'), '👍');

  store.deleteMessage('acct-1', 'chat-1', 'm1');
  assert.equal(store.getMessageById('acct-1', 'chat-1', 'm1'), null);
  assert.equal(store.getReaction('acct-1', 'm1'), null);
});

test('applyReaction surfaces the most recently reacted sender, and an empty reaction clears it', () => {
  const store = freshStore();
  store.applyReaction('acct-1', { targetMessageId: 'm1', senderId: 'a@s.whatsapp.net', reaction: '👍' });
  assert.equal(store.getReaction('acct-1', 'm1'), '👍');

  store.applyReaction('acct-1', { targetMessageId: 'm1', senderId: 'b@s.whatsapp.net', reaction: '❤️' });
  assert.equal(store.getReaction('acct-1', 'm1'), '❤️');

  store.applyReaction('acct-1', { targetMessageId: 'm1', senderId: 'b@s.whatsapp.net', reaction: '' });
  assert.equal(store.getReaction('acct-1', 'm1'), '👍', 'clearing one sender\'s reaction falls back to the remaining one');
});

test('deleteChat removes the chat and every message in it, scoped to that account only', () => {
  const store = freshStore();
  store.upsertMessages('acct-1', [{ chatId: 'chat-1', messageId: 'm1', timestamp: 10, fromMe: false, waMessage: {}, overviewMessage: { body: 'x', text: 'x', timestamp: 10, hasMedia: false, system: null } }]);
  store.upsertMessages('acct-2', [{ chatId: 'chat-1', messageId: 'm1', timestamp: 10, fromMe: false, waMessage: {}, overviewMessage: { body: 'y', text: 'y', timestamp: 10, hasMedia: false, system: null } }]);

  store.deleteChat('acct-1', 'chat-1');

  assert.deepEqual(store.getChatsOverview('acct-1'), []);
  assert.equal(store.getMessageById('acct-1', 'chat-1', 'm1'), null);
  // The same chat id under a different account is untouched.
  assert.equal(store.getChatsOverview('acct-2').length, 1);
});

test('upsertContacts fills in a name/picture without clobbering an existing one with null', () => {
  const store = freshStore();
  store.upsertContacts('acct-1', [{ id: 'c1', name: 'First Name', picture: null, phone: '5511999999999' }]);
  store.upsertContacts('acct-1', [{ id: 'c1', name: null, picture: 'https://pps.whatsapp.net/x.jpg', phone: null }]);

  const contact = store.getContact('acct-1', 'c1');
  assert.equal(contact.name, 'First Name');
  assert.equal(contact.picture, 'https://pps.whatsapp.net/x.jpg');
  assert.equal(contact.phone, '5511999999999');
});

test('lid mapping round-trips, and an unmapped lid resolves to null', () => {
  const store = freshStore();
  assert.equal(store.resolveLid('acct-1', 'unknown@lid'), null);
  store.setLidMapping('acct-1', 'abc@lid', '5511999999999@s.whatsapp.net');
  assert.equal(store.resolveLid('acct-1', 'abc@lid'), '5511999999999@s.whatsapp.net');
});

test('deleteAccountData clears chats, messages, contacts, lids, and reactions for that account only', () => {
  const store = freshStore();
  store.upsertMessages('acct-1', [{ chatId: 'chat-1', messageId: 'm1', timestamp: 10, fromMe: false, waMessage: {}, overviewMessage: { body: 'x', text: 'x', timestamp: 10, hasMedia: false, system: null } }]);
  store.upsertContacts('acct-1', [{ id: 'c1', name: 'Someone' }]);
  store.applyReaction('acct-1', { targetMessageId: 'm1', senderId: 'a@s.whatsapp.net', reaction: '👍' });
  store.setLidMapping('acct-1', 'abc@lid', '5511999999999@s.whatsapp.net');

  store.deleteAccountData('acct-1');

  assert.deepEqual(store.getChatsOverview('acct-1'), []);
  assert.equal(store.getContact('acct-1', 'c1'), null);
  assert.equal(store.getReaction('acct-1', 'm1'), null);
  assert.equal(store.resolveLid('acct-1', 'abc@lid'), null);
});
