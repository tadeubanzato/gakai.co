// A minimal async mutual-exclusion guard, kept in a plain .mjs file (no
// JSX) so it's unit-testable with Node's built-in test runner directly.
// Skips (returns undefined) if `key` is already in flight in `inFlight`,
// otherwise runs `fn` and always clears the key afterward. Prevents a
// rapid double-click, or an effect racing a manual action, from firing two
// concurrent requests for the same thing.
export async function runExclusive(inFlight, key, fn) {
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}
