import assert from 'node:assert/strict';
import test from 'node:test';
import { pickChat, recallChat, rememberChat } from '../../client/last-chat.mjs';

const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) }; };
const chats = [{ id: 'newest' }, { id: 'older' }, { id: 'oldest' }];

test('the conversation you were last in is reopened, per account', () => {
  const storage = memory();
  rememberChat('acc-a', 'older', storage);
  rememberChat('acc-b', 'oldest', storage);
  assert.equal(pickChat(chats, 'acc-a', storage).id, 'older');
  assert.equal(pickChat(chats, 'acc-b', storage).id, 'oldest');
});

test('with nothing remembered, or a remembered chat that is not in the list, the newest opens', () => {
  const storage = memory();
  assert.equal(pickChat(chats, 'acc-a', storage).id, 'newest');
  rememberChat('acc-a', 'gone', storage);
  assert.equal(pickChat(chats, 'acc-a', storage).id, 'newest');
  assert.equal(pickChat([], 'acc-a', storage), undefined);
});

test('forgetting clears it, and unusable storage never throws', () => {
  const storage = memory();
  rememberChat('acc-a', 'older', storage);
  rememberChat('acc-a', null, storage);
  assert.equal(recallChat('acc-a', storage), null);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  rememberChat('acc-a', 'older', broken);
  assert.equal(pickChat(chats, 'acc-a', broken).id, 'newest');
});
