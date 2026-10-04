// Pagination for the conversation list. Order is (last activity, id) descending — a total
// order, so a cursor is exact even when many chats share a timestamp, and nothing is
// skipped or repeated when a chat moves between page requests (unlike OFFSET).
import { isDisplayableConversation } from './jid.mjs';
import { chatTimestamp, hasMessageContent } from './message.mjs';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export function clampPageSize(value, fallback = DEFAULT_PAGE_SIZE) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGE_SIZE) : fallback;
}

export function encodeCursor(timestamp, id) {
  return Buffer.from(JSON.stringify([Number(timestamp) || 0, String(id)])).toString('base64url');
}

// Returns { timestamp, id } or null for anything that is not a cursor this module issued.
export function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const [timestamp, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isFinite(timestamp) && typeof id === 'string' && id ? { timestamp, id } : null;
  } catch { return null; }
}

// In-memory equivalent of the store's SQL page query (used by the mock provider).
export function pageConversations(chats, { limit = DEFAULT_PAGE_SIZE, cursor, archived = false } = {}) {
  const after = decodeCursor(cursor);
  const size = clampPageSize(limit);
  const rows = chats
    .filter(chat => isDisplayableConversation(chat.id) && hasMessageContent(chat) && Boolean(chat.archived) === Boolean(archived))
    .map(chat => ({ chat, timestamp: chatTimestamp(chat) }))
    .sort((a, b) => b.timestamp - a.timestamp || (a.chat.id < b.chat.id ? 1 : -1))
    .filter(({ chat, timestamp }) => !after || timestamp < after.timestamp || (timestamp === after.timestamp && chat.id < after.id));
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? encodeCursor(page[size - 1].timestamp, page[size - 1].chat.id) : null;
  return { chats: page.map(row => row.chat), nextCursor };
}
