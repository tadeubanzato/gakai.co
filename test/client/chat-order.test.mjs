import assert from 'node:assert/strict';
import test from 'node:test';
import { compareChats } from '../../client/app-helpers.mjs';

const chat = (id, timestamp, pinned = false) => ({ id, timestamp, pinned });
const order = list => [...list].sort(compareChats).map(item => item.id);

test('a pinned chat stays above newer unpinned chats', () => {
  assert.deepEqual(order([chat('new', 300), chat('old-pinned', 100, true), chat('mid', 200)]), ['old-pinned', 'new', 'mid']);
});

test('pinned chats are ordered among themselves by recent activity, then the rest by recent activity', () => {
  assert.deepEqual(order([chat('b', 50, true), chat('c', 400), chat('a', 150, true), chat('d', 300)]), ['a', 'b', 'c', 'd']);
});

test('falls back to the last message time when a chat has no timestamp, and tolerates none at all', () => {
  const list = [{ id: 'x', lastMessage: { timestamp: 500 } }, chat('y', 100), { id: 'z' }];
  assert.deepEqual(order(list), ['x', 'y', 'z']);
});
