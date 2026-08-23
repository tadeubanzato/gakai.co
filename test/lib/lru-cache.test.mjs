import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundedCache } from '../../src/lib/lru-cache.mjs';

test('a get() hit moves the key to the back of eviction order (real LRU, not FIFO)', () => {
  const cache = createBoundedCache({ limit: 3 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.get('a'); // touch the oldest key so it's no longer the eviction target
  cache.set('d', 4); // over limit: FIFO would evict 'a', LRU must evict 'b'

  assert.equal(cache.get('a'), 1, 'a was touched most recently among the original three and must survive');
  assert.equal(cache.get('b'), undefined, 'b is now the least-recently-used entry and must be evicted');
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.get('d'), 4);
});

test('entries expire after ttlMs and are treated as absent', async () => {
  const cache = createBoundedCache({ limit: 10, ttlMs: 20 });
  cache.set('key', 'value');
  assert.equal(cache.get('key'), 'value');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(cache.get('key'), undefined);
});

test('a per-set ttlMs override extends an existing entry past the cache default', async () => {
  const cache = createBoundedCache({ limit: 10, ttlMs: 20 });
  cache.set('key', 'short-lived');
  cache.set('key', 'long-lived', { ttlMs: 500 });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(cache.get('key'), 'long-lived', 'the override TTL must replace the shorter default TTL for this entry');
});

test('without a ttl, entries only expire by LRU eviction, never by time', async () => {
  const cache = createBoundedCache({ limit: 10 });
  cache.set('key', 'value');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(cache.get('key'), 'value');
});

test('delete() removes an entry outright', () => {
  const cache = createBoundedCache({ limit: 10 });
  cache.set('key', 'value');
  cache.delete('key');
  assert.equal(cache.get('key'), undefined);
});
