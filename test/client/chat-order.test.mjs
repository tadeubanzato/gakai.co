import assert from 'node:assert/strict';
import test from 'node:test';
import { compareChats } from '../../client/app-helpers.mjs';

const chat = (id, timestamp, pinned = false) => ({ id, timestamp, pinned });
const order = list => [...list].sort(compareChats).map(item => item.id);

test('chats are ordered purely by recent activity; a pinned chat gets no special place', () => {
  assert.deepEqual(order([chat('new', 300), chat('old-pinned', 100, true), chat('mid', 200)]), ['new', 'mid', 'old-pinned']);
});

test('chats with the same timestamp keep a stable order (id descending), matching the server', () => {
  assert.deepEqual(order([chat('a', 100), chat('c', 100), chat('b', 100)]), ['c', 'b', 'a']);
});

test('falls back to the last message time when a chat has no timestamp, and tolerates none at all', () => {
  const list = [{ id: 'x', lastMessage: { timestamp: 500 } }, chat('y', 100), { id: 'z' }];
  assert.deepEqual(order(list), ['x', 'y', 'z']);
});
