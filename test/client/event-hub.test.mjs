import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventHub } from '../../client/event-hub.mjs';

function harness() {
  const opened = [];
  const listeners = new Map();
  const doc = { visibilityState: 'visible', addEventListener: (type, fn) => listeners.set(type, fn) };
  const open = url => {
    const source = { url, closed: false, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener() { this.handlers = {}; }, close() { this.closed = true; } };
    opened.push(source);
    return source;
  };
  const hub = createEventHub({ open, doc });
  const emit = (source, change) => source.handlers.gakai?.({ data: JSON.stringify(change) });
  const setVisible = visible => { doc.visibilityState = visible ? 'visible' : 'hidden'; listeners.get('visibilitychange')(); };
  return { hub, opened, emit, setVisible };
}

test('every subscriber shares one connection covering all accounts', () => {
  const { hub, opened } = harness();
  hub.subscribe(['a'], () => {});
  hub.subscribe(['a'], () => {});      // the same account followed by a second view
  assert.equal(opened.length, 1, 'following the same account twice adds no connection');
  hub.subscribe(['b'], () => {});
  assert.equal(opened.length, 2, 'a new account swaps to one connection covering both');
  const live = opened.filter(source => !source.closed);
  assert.equal(live.length, 1);
  assert.match(live[0].url, /accountId=a%2Cb&after=now/);
});

test('events reach only the subscribers following that account', () => {
  const { hub, opened, emit } = harness();
  const seen = [];
  hub.subscribe(['a'], (_e, change) => seen.push(['a', change.type]));
  hub.subscribe(['b'], (_e, change) => seen.push(['b', change.type]));
  emit(opened.at(-1), { type: 'message.received', account: { id: 'b' } });
  emit(opened.at(-1), { type: 'chat.read', account: { id: 'a' } });
  emit(opened.at(-1), { type: 'x', account: { id: 'zzz' } });
  assert.deepEqual(seen, [['b', 'message.received'], ['a', 'chat.read']]);
});

test('a hidden tab holds no connection and tells subscribers to catch up when it returns', () => {
  const { hub, opened, setVisible } = harness();
  let resumed = 0;
  hub.subscribe(['a'], () => {}, () => { resumed += 1; });
  assert.equal(hub.connected, true);
  setVisible(false);
  assert.equal(hub.connected, false);
  assert.equal(opened.at(-1).closed, true);
  setVisible(true);
  assert.equal(hub.connected, true);
  assert.equal(resumed, 1);
});

test('the last unsubscribe closes the connection', () => {
  const { hub, opened } = harness();
  const off = hub.subscribe(['a'], () => {});
  off();
  assert.equal(hub.connected, false);
  assert.equal(opened.at(-1).closed, true);
});

test('a malformed event is ignored', () => {
  const { hub, opened } = harness();
  hub.subscribe(['a'], () => assert.fail('should not be called'));
  opened.at(-1).handlers.gakai({ data: 'not json' });
});
