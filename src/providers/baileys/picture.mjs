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

/**
 * Background upkeep for the inbox's avatars: walks an account's chats and
 * re-asks WhatsApp for any picture that is missing, expired, or will expire
 * before the next sweep — so the inbox never has to wait on (or show a gap
 * for) a lookup at the moment someone opens it.
 *
 * Each lookup is a live WhatsApp request, so they run one at a time with a
 * pause in between rather than as a burst, and only one sweep per account
 * runs at a time.
 */
export function createPictureRefresher({ listChatIds, getStoredPicture, isKnownMissing, refresh, lookaheadMs = 0, pauseMs = 1500, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const running = new Set();

  async function sweep(accountId, { isActive = () => true } = {}) {
    if (running.has(accountId)) return { skipped: true, checked: 0, refreshed: 0 };
    running.add(accountId);
    let checked = 0, refreshed = 0;
    try {
      for (const chatId of listChatIds(accountId)) {
        // The account disconnected (or was removed) mid-sweep — stop quietly.
        if (!isActive()) break;
        if (isKnownMissing(accountId, chatId)) continue;
        const stored = getStoredPicture(accountId, chatId);
        if (stored && !pictureUrlExpired(stored, Date.now() + lookaheadMs)) continue;
        checked++;
        if (await refresh(accountId, chatId)) refreshed++;
        await sleep(pauseMs);
      }
    } finally { running.delete(accountId); }
    return { skipped: false, checked, refreshed };
  }

  return { sweep };
}
