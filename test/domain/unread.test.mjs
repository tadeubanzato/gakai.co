import assert from 'node:assert/strict';
import test from 'node:test';
import { countsAsUnread, isReadElsewhere, startsUnread } from '../../src/domain/unread.mjs';

const incoming = (extra = {}) => ({ fromMe: false, body: 'hello', text: 'hello', hasMedia: false, system: null, timestamp: 1000, ...extra });

test('only incoming messages with real content count as unread', () => {
  assert.equal(countsAsUnread(incoming()), true);
  assert.equal(countsAsUnread(incoming({ body: '', text: '', hasMedia: true })), true, 'a photo counts');
  assert.equal(countsAsUnread(incoming({ body: '', text: '', system: { kind: 'call', label: 'Missed call' } })), true, 'a missed call counts');
  assert.equal(countsAsUnread(incoming({ fromMe: true })), false, 'never your own message');
  assert.equal(countsAsUnread(incoming({ body: '', text: '', system: { kind: 'group', label: 'Ana joined' } })), false, 'group events are not messages');
  assert.equal(countsAsUnread(incoming({ body: '', text: '' })), false, 'an empty message');
  assert.equal(countsAsUnread(null), false);
});

test('a live incoming message newer than the read cursor starts unread', () => {
  assert.equal(startsUnread({ source: 'live', message: incoming({ timestamp: 2000 }), readCursor: 1500 }), true);
  assert.equal(startsUnread({ source: 'live', message: incoming({ timestamp: 2000 }) }), true, 'a chat never read starts at 0');
});

test('history sync never makes a message unread, whatever it says', () => {
  assert.equal(startsUnread({ source: 'history', message: incoming({ timestamp: 9999 }), readCursor: 0 }), false);
});

test('a message at or before the read cursor is already read', () => {
  assert.equal(startsUnread({ source: 'live', message: incoming({ timestamp: 1500 }), readCursor: 1500 }), false);
  assert.equal(startsUnread({ source: 'live', message: incoming({ timestamp: 1000 }), readCursor: 1500 }), false);
});

test('your own messages and non-content updates never start unread', () => {
  assert.equal(startsUnread({ source: 'live', message: incoming({ fromMe: true, timestamp: 2000 }), readCursor: 0 }), false);
  assert.equal(startsUnread({ source: 'live', message: incoming({ body: '', text: '', timestamp: 2000 }), readCursor: 0 }), false);
});

test('a READ status on an incoming message means it was read on another device', () => {
  const key = { remoteJid: '5511999777057@s.whatsapp.net', id: 'ABC', fromMe: false };
  assert.equal(isReadElsewhere({ key, update: { status: 4 } }), true);
  assert.equal(isReadElsewhere({ key, update: { status: 5 } }), true, 'played counts as read');
  assert.equal(isReadElsewhere({ key, update: { status: 3 } }), false, 'delivered is not read');
  assert.equal(isReadElsewhere({ key: { ...key, fromMe: true }, update: { status: 4 } }), false, 'the other person reading MY message is not my read');
  assert.equal(isReadElsewhere({ key: { id: 'X' }, update: { status: 4 } }), false);
  assert.equal(isReadElsewhere({ key, update: {} }), false);
});
