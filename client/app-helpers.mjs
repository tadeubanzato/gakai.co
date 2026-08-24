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

// Shared fetch wrapper for both client entrypoints. `credentials:
// "same-origin"` ensures the session cookie is always sent — without it,
// a request issued from a context where the browser wouldn't otherwise
// attach cookies by default silently runs unauthenticated instead of
// failing loudly.
export async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}
