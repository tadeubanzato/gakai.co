/**
 * A size-bounded cache with real LRU eviction and optional per-entry TTL.
 *
 * `Map` preserves insertion order, so evicting `keys().next().value` when
 * over the size limit is only a valid LRU policy if every read also moves
 * its key to the end of that order. A plain `Map` used as a cache without
 * doing that is FIFO — it evicts the oldest-inserted entry regardless of
 * how recently or often it was actually used.
 */
export function createBoundedCache({ limit, ttlMs } = {}) {
  const map = new Map();

  function get(key) {
    if (!map.has(key)) return undefined;
    const entry = map.get(key);
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    map.delete(key);
    map.set(key, entry); // bump recency on every hit
    return entry.value;
  }

  function set(key, value, options = {}) {
    map.delete(key); // re-insertion must land at the end even for an existing key
    const effectiveTtl = options.ttlMs ?? ttlMs;
    map.set(key, { value, expiresAt: effectiveTtl !== undefined ? Date.now() + effectiveTtl : undefined });
    if (limit && map.size > limit) map.delete(map.keys().next().value);
  }

  function del(key) {
    map.delete(key);
  }

  return { get, set, delete: del, get size() { return map.size; } };
}
