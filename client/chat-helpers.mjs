// Pure message-list helpers, kept in a plain .mjs file (no JSX) so they can
// be unit-tested with Node's built-in test runner without a JSX transform.

// Keep the first request small: WEBJS may need a browser-backed provider call
// for each history page, so a large eager load makes opening chats sluggish.
export const PAGE_SIZE = 20;

// WAHA engines may return a message id as either a string or a structured key.
// String(object) is always "[object Object]", which made every such outgoing
// message share one React/merge key and caused later sends to replace earlier
// bubbles. Preserve a provider-supplied serialized value, or serialize the
// complete key as a stable, unique client identity.
export function serializedId(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const direct = value._serialized || value.serialized;
  if (typeof direct === "string" || typeof direct === "number") return String(direct);
  if (typeof value.id === "string" || typeof value.id === "number") return String(value.id);
  try { return JSON.stringify(value); } catch { return ""; }
}
export const idFor = (message, index) => serializedId(message?.id) || `${message?.timestamp || 0}-${message?.fromMe ? "out" : "in"}-${message?.body || message?.text || "message"}-${index}`;
export const stamp = (message) => { const value=Number(message?.timestamp); if(Number.isFinite(value)&&value>0)return value; const parsed=Date.parse(message?.timestamp||""); return Number.isFinite(parsed)?Math.floor(parsed/1000):0; };
export const pageOf = (result) => Array.isArray(result) ? result : (result?.messages || []);
// `before` pages by the oldest loaded message's timestamp instead of a
// numeric offset, so paging back through history can't drift/skip when a new
// message arrives concurrently (offset math shifts under a live insertion;
// a timestamp cursor doesn't).
export const endpoint = (accountId, chatId, before) => `/api/app/accounts/${encodeURIComponent(accountId)}/messages?chatId=${encodeURIComponent(chatId)}&limit=${PAGE_SIZE}${before ? `&before=${before}` : ""}`;

// After a failed send, restore the composer's text only if the reader
// hasn't typed something new in the meantime — never stomp over that.
export function nextComposerValue(currentValue, failedText) {
  return currentValue ? currentValue : failedText;
}

export function merge(current, extra) {
  const keyed = new Map();
  [...current, ...extra].forEach((message, index) => keyed.set(idFor(message, index), message));
  return [...keyed.values()].sort((a, b) => stamp(a) - stamp(b));
}
