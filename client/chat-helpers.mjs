// Pure message-list helpers, kept in a plain .mjs file (no JSX) so they can
// be unit-tested with Node's built-in test runner without a JSX transform.

// Keep the first request small: fetching a history page can be a relatively
// expensive provider call, so a large eager load makes opening chats sluggish.
export const PAGE_SIZE = 20;

// The provider may return a message id as either a string or a structured key.
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

// Merge a provider send-ack onto the optimistic pending message. The
// provider's send acknowledgement doesn't echo back the quoted message being
// replied to, so resultMessage.replyTo comes back null/absent — preserve the
// client's own pending.replyTo (already known from the reader's Reply click)
// instead of losing the reply context the moment the ack arrives.
export function confirmSentMessage(pending, resultMessage) {
  if (!resultMessage) return null;
  return {
    ...pending,
    ...resultMessage,
    body: resultMessage.body || resultMessage.text || pending.body,
    text: resultMessage.text || resultMessage.body || pending.text || pending.body,
    replyTo: resultMessage.replyTo || pending.replyTo,
    pending: false,
  };
}

// The reader is "in a mention" when the text immediately before the caret is
// an unbroken "@…" run — no whitespace and no second "@" since the "@". Returns
// the partial name typed so far (may be ""), or null when the caret isn't in a
// mention. Drives the participant suggestion menu in the composer.
export function mentionQueryAt(text, caret) {
  const before = String(text || "").slice(0, Math.max(0, caret ?? 0));
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  return match ? match[1] : null;
}

// Replace the active "@query" fragment before the caret with "@Name " and
// report where the caret should land afterward. Returns null if the caret
// isn't in a mention fragment (so the caller leaves the field untouched).
export function applyMentionPick(text, caret, name) {
  const value = String(text || "");
  const at = Math.max(0, caret ?? 0);
  const before = value.slice(0, at);
  const after = value.slice(at);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const atSign = before.length - match[1].length - 1; // index of the "@"
  const insert = `@${name} `;
  return { text: before.slice(0, atSign) + insert + after.replace(/^\s/, ""), caret: atSign + insert.length };
}

// Turn the composer's human-readable text (which carries "@Display Name" for
// each participant the reader picked from the mention menu) into the wire form
// WhatsApp expects: each picked participant's bare number as "@<number>" in the
// text, plus the matching JIDs collected into a `mentions` array Baileys puts
// on contextInfo.mentionedJid. A pick whose "@Name" the reader has since edited
// out of the text is dropped — never sent as a silent, invisible mention.
export function buildMentionPayload(text, picks) {
  let wire = String(text || "");
  const mentions = [];
  for (const pick of picks || []) {
    if (!pick?.jid || !pick?.name || !pick?.number) continue;
    const token = `@${pick.name}`;
    if (!wire.includes(token)) continue;
    wire = wire.split(token).join(`@${pick.number}`);
    if (!mentions.includes(pick.jid)) mentions.push(pick.jid);
  }
  return { text: wire, mentions };
}

// Same mapping the server's adapter uses, kept here so the composer can show
// the right preview and the optimistic bubble picks the right player.
export function mediaKindFromMime(mimetype) {
  const type = String(mimetype || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "document";
}

export function humanFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// The optimistic bubble shown the instant a file is picked, before the send
// round-trips. `objectUrl` is a local blob: URL — MediaCard's mediaSrc already
// accepts blob:/data: as-is, so the attachment renders immediately.
export function buildMediaPending(file, caption, objectUrl) {
  const mimetype = file?.type || "application/octet-stream";
  return {
    id: `pending-${Date.now()}`,
    body: caption || "",
    text: caption || "",
    fromMe: true,
    timestamp: Math.floor(Date.now() / 1000),
    pending: true,
    hasMedia: true,
    media: { url: objectUrl, mimetype, filename: file?.name || null },
    mediaUrl: objectUrl,
  };
}

export function merge(current, extra) {
  const keyed = new Map();
  [...current, ...extra].forEach((message, index) => keyed.set(idFor(message, index), message));
  return [...keyed.values()].sort((a, b) => stamp(a) - stamp(b));
}
