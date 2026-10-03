/**
 * WhatsApp profile-picture links are signed and short-lived: the `oe` query
 * parameter carries the expiry as hex epoch seconds, and the CDN answers 403
 * once it has passed. A stored link is therefore only a cache — past its
 * expiry it must be treated as "no picture known" so the next lookup asks
 * WhatsApp for a fresh one instead of serving a dead link forever.
 */

// Treat a link about to expire as already expired, so one handed to the
// browser now is still loadable by the time the avatar is actually requested.
const EXPIRY_MARGIN_MS = 60 * 60 * 1000;

export function pictureUrlExpired(value, nowMs = Date.now()) {
  if (!value) return false;
  let expiry;
  try { expiry = parseInt(new URL(String(value)).searchParams.get('oe') || '', 16); } catch { return false; }
  // No readable expiry (a data: URI, a link without `oe`) — nothing to judge by.
  return Number.isFinite(expiry) && expiry * 1000 - EXPIRY_MARGIN_MS <= nowMs;
}

export function freshPictureUrl(value, nowMs = Date.now()) {
  return value && !pictureUrlExpired(value, nowMs) ? value : null;
}
