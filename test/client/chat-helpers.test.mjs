import assert from 'node:assert/strict';
import test from 'node:test';
import { serializedId, idFor, stamp, pageOf, endpoint, merge, confirmSentMessage, PAGE_SIZE } from '../../client/chat-helpers.mjs';

test('serializedId resolves a structured provider id to a stable string, never "[object Object]"', () => {
  assert.equal(serializedId({ _serialized: 'abc' }), 'abc');
  assert.equal(serializedId({ serialized: 'def' }), 'def');
  assert.equal(serializedId({ id: 'ghi' }), 'ghi');
  assert.equal(serializedId('already-a-string'), 'already-a-string');
  assert.equal(serializedId(42), '42');
  assert.notEqual(serializedId({ fromMe: true, remote: 'x' }), '[object Object]');
});

test('stamp normalizes numeric and ISO-string timestamps to whole seconds', () => {
  assert.equal(stamp({ timestamp: 1735689600 }), 1735689600);
  assert.equal(stamp({ timestamp: '2025-01-01T00:00:00Z' }), Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000));
  assert.equal(stamp({}), 0);
});

test('pageOf accepts both a raw array response and a {messages: [...]} envelope', () => {
  assert.deepEqual(pageOf([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(pageOf({ messages: [1, 2] }), [1, 2]);
  assert.deepEqual(pageOf({}), []);
});

test('endpoint omits the before param on the first page and includes it for older pages', () => {
  const first = endpoint('acct', 'chat@c.us');
  const older = endpoint('acct', 'chat@c.us', 1735689600);
  assert.doesNotMatch(first, /before=/);
  assert.match(older, /before=1735689600/);
  assert.match(first, new RegExp(`limit=${PAGE_SIZE}`));
});

test('merge dedups by message id and sorts ascending (oldest first, newest last)', () => {
  const current = [{ id: 'a', timestamp: 100 }, { id: 'b', timestamp: 200 }];
  const extra = [{ id: 'b', timestamp: 200 }, { id: 'c', timestamp: 150 }];
  const result = merge(current, extra);
  assert.deepEqual(result.map(m => m.id), ['a', 'c', 'b']);
});

test('confirmSentMessage keeps the reply context when the provider send-ack omits it (the actual reported bug)', () => {
  // A send-ack for a reply doesn't echo back the quoted message — messageView()
  // normalizes that absence to replyTo: null.
  // Losing pending.replyTo here made a real reply render as a bare message,
  // giving the reader the impression their reply didn't register.
  const pending = { id: 'pending-1', body: 'sounds good', fromMe: true, timestamp: 100, pending: true, replyTo: { id: 'quoted-1', body: 'are we still on for lunch?', hasMedia: false } };
  const resultMessage = { id: 'real-1', body: 'sounds good', text: 'sounds good', fromMe: true, timestamp: 101, replyTo: null };
  const confirmed = confirmSentMessage(pending, resultMessage);
  assert.equal(confirmed.pending, false);
  assert.deepEqual(confirmed.replyTo, pending.replyTo);
});

test('confirmSentMessage prefers the provider-supplied replyTo when the ack does include one', () => {
  const pending = { id: 'pending-2', body: 'hi', fromMe: true, timestamp: 100, pending: true, replyTo: { id: 'quoted-2', body: 'stale local guess' } };
  const resultMessage = { id: 'real-2', body: 'hi', fromMe: true, timestamp: 101, replyTo: { id: 'quoted-2', body: 'the real quoted text' } };
  const confirmed = confirmSentMessage(pending, resultMessage);
  assert.equal(confirmed.replyTo.body, 'the real quoted text');
});

test('confirmSentMessage returns null when the server gave no message back', () => {
  assert.equal(confirmSentMessage({ id: 'pending-3' }, null), null);
});

test('merge keeps the newer copy of a message id at whatever position its timestamp sorts to (last write wins)', () => {
  // e.g. a media-resolve update replacing a placeholder for the same message.
  const current = [{ id: 'a', timestamp: 100, body: 'placeholder' }];
  const extra = [{ id: 'a', timestamp: 100, body: 'resolved' }];
  const result = merge(current, extra);
  assert.equal(result.length, 1);
  assert.equal(result[0].body, 'resolved');
});
