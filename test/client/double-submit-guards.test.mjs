import assert from 'node:assert/strict';
import test from 'node:test';
import { runExclusive } from '../../client/app-helpers.mjs';

test('a second call with the same key while the first is still in flight is skipped', async () => {
  let calls = 0;
  const inFlight = new Set();
  let releaseFirst;
  const first = runExclusive(inFlight, 'chat-1', () => new Promise(resolve => {
    calls += 1;
    releaseFirst = resolve;
  }));

  // The first call is now in flight (holds the key); a second call for the
  // same key must not invoke fn at all — this is the double-click/duplicate
  // mark-as-read scenario.
  const second = await runExclusive(inFlight, 'chat-1', () => { calls += 1; return 'should not run'; });
  assert.equal(second, undefined);
  assert.equal(calls, 1);

  releaseFirst();
  await first;
});

test('a different key is not blocked by an in-flight call for another key', async () => {
  let calls = 0;
  const inFlight = new Set();
  let releaseFirst;
  const first = runExclusive(inFlight, 'chat-1', () => new Promise(resolve => { calls += 1; releaseFirst = resolve; }));

  const second = await runExclusive(inFlight, 'chat-2', () => { calls += 1; return 'ran'; });
  assert.equal(second, 'ran');
  assert.equal(calls, 2);

  releaseFirst();
  await first;
});

test('the key is released after completion, so a later call with the same key runs normally', async () => {
  const inFlight = new Set();
  let calls = 0;
  await runExclusive(inFlight, 'pairing', () => { calls += 1; });
  await runExclusive(inFlight, 'pairing', () => { calls += 1; });
  assert.equal(calls, 2);
  assert.equal(inFlight.size, 0);
});

test('the key is released even when fn throws', async () => {
  const inFlight = new Set();
  await assert.rejects(runExclusive(inFlight, 'pairing', () => { throw new Error('boom'); }));
  assert.equal(inFlight.has('pairing'), false);
});
