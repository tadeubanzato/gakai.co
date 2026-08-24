/**
 * Provider-neutral normalization: WAHA payload shapes in, Gakai's stable
 * message/chat view model out. `server.mjs` binds `providerUrl` once and
 * re-exposes these as its original single-argument call signatures.
 */
import { createHash } from 'node:crypto';

export function avatarUrl(value, providerUrl) {
  const raw = String(value || '').trim();
  // `new URL('', providerUrl)` doesn't throw — it resolves to providerUrl
  // itself (an internal-only Docker address the browser can't reach). Without
  // this guard, a chat/message with no picture yielded that bogus internal
  // URL instead of null, which then blocked the real per-chat picture lookup
  // (callers only fall back to it when the picture is falsy) and shipped a
  // broken image URL to the browser instead.
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) return raw;
  try {
    const url = new URL(raw, providerUrl);
    if (url.pathname.startsWith('/api/files/')) return `/api/app/media?path=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function normalizedTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function chatTimestamp(chat) {
  return normalizedTimestamp(chat.lastMessage?.timestamp || chat.lastMessage?._data?.timestamp || chat._chat?.lastMessage?.timestamp || chat._chat?.lastMessage?._data?.timestamp || chat.timestamp || chat._chat?.timestamp || 0);
}

// WAHA/WEBJS can touch a chat's timestamp during a background resync with no
// real new message behind it (observed: several unrelated chats — including
// ones with zero actual message history — sharing near-identical touched
// timestamps, all with empty body/text and hasMedia:false). chatTimestamp()
// trusts that value at face value, which makes a dormant or even entirely
// nonexistent conversation look freshly active. Use this alongside
// chatTimestamp() wherever "recently active" needs to mean a real message,
// not just a touched timestamp.
//
// A real WhatsApp call also has empty body/text/hasMedia, but it only exists
// because an actual call happened — so it's the one system event trustworthy
// enough to count as real activity here. Every *other* system event
// (encryption-handshake notices, group/username-change notifications, the
// generic system fallback) is administrative noise WAHA can generate on its
// own without any real communication ever taking place — observed live: a
// contact with no real message history ever, resurfaced at the top of the
// inbox purely because of one of these. Only systemMessageView()'s 'call'
// kind counts; every other kind is excluded the same as an empty touch.
export function hasMessageContent(chat) {
  const lastMessage = chat.lastMessage || chat._chat?.lastMessage;
  if (!lastMessage) return false;
  return Boolean(lastMessage.body || lastMessage.text || lastMessage.hasMedia || systemMessageView(lastMessage)?.kind === 'call');
}

export function chatOverview(chat, providerUrl) {
  return {
    id: chat.id, name: chat.name, picture: avatarUrl(chat.picture, providerUrl),
    unreadCount: Number(chat.unreadCount ?? chat.unreadMessagesCount ?? chat._chat?.unreadCount ?? 0) || 0,
    timestamp: chatTimestamp(chat),
    lastMessage: chat.lastMessage ? { body: chat.lastMessage.body || '', text: chat.lastMessage.text || '', timestamp: normalizedTimestamp(chat.lastMessage.timestamp || chat.lastMessage._data?.timestamp || 0), hasMedia: Boolean(chat.lastMessage.hasMedia), system: systemMessageView(chat.lastMessage) } : null,
  };
}

export function systemMessageView(message) {
  const data = message._data || {}, type = String(message.type || data.type || data.subtype || '').toLowerCase();
  if (type === 'call_log') {
    const video = Boolean(data.isVideoCall), outcome = String(data.callOutcome || '').replace(/_/g, ' ').toLowerCase();
    const duration = Number(data.callDuration || 0), minutes = Math.floor(duration / 60), seconds = duration % 60;
    const length = duration > 0 ? ` · ${minutes ? `${minutes}m ` : ''}${seconds}s` : '';
    return { kind: 'call', label: `${video ? 'Video' : 'Voice'} call${outcome ? ` · ${outcome}` : ''}${length}` };
  }
  if (type === 'gp2') return { kind: 'group-event', label: 'Group activity' };
  if (type === 'e2e_notification') return { kind: 'security', label: 'Messages are end-to-end encrypted' };
  return type ? { kind: 'system', label: 'WhatsApp system message' } : null;
}

// @<numeric-id> mentions appear both in a message's own body and in the body
// of whatever it's replying to (replyTo.body) — both need the same
// resolution, from one combined set of ids, so a name only has to be looked
// up once even if it appears in both places.
export function extractMentionIds(...texts) {
  return [...new Set(texts.flatMap(text => [...String(text || '').matchAll(/@(\d{5,})/g)].map(match => match[1])))].slice(0, 8);
}

export function resolveMentionLabels(text, labels) {
  return String(text || '').replace(/@(\d{5,})/g, (mention, id) => labels.has(id) ? `@${labels.get(id)}` : mention);
}

// Whether a message's raw @-mention jid list (message._data.mentionedJidList)
// includes the account's own identity. Mentions can come back as either a
// `@c.us` or `@lid` jid depending on the engine, so compare both the full
// jid and the number-only portion — the same dual check enrichMessage's
// per-mention isMe flag already uses, kept in sync here for the n8n/native
// reply dispatch's DM-or-tagged scoping.
export function mentionsIdentity(mentionedJidList, ownId) {
  if (!ownId || !Array.isArray(mentionedJidList) || !mentionedJidList.length) return false;
  const ownNumber = ownId.replace(/@.*$/, '');
  return mentionedJidList.some(rawId => {
    const id = String(rawId || '');
    return id === ownId || id.replace(/@.*$/, '') === ownNumber;
  });
}

export function providerMessageId(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object') return null;
  const id = value._serialized || value.serialized || value.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

export function replyView(reply) {
  if (!reply || typeof reply !== 'object') return null;
  return { id: providerMessageId(reply.id), body: reply.body || reply.text || '', hasMedia: Boolean(reply.hasMedia || reply.media), participant: reply.participant || null };
}

// When the provider gives no usable id at all, derive a deterministic one
// from stable fields. A client-side per-render fallback (e.g. an array
// index) shifts as the list reorders/merges, causing duplicate bubbles or
// lost local UI state (an open reaction picker) across a live-poll merge.
// Hashing stable fields here means the same input always produces the same
// id, from any caller, on any render.
function derivedMessageId(message, timestamp, senderId) {
  const seed = `${timestamp}|${message.fromMe ? 'out' : 'in'}|${senderId || ''}|${message.body || message.text || ''}`;
  return `derived_${createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

export function messageView(message, providerUrl) {
  const participant = message.participant && typeof message.participant === 'object' ? message.participant : {};
  const senderId = participant.id || message.participant || message.author || message.from || null;
  const senderName = participant.name || message.participantName || message.authorName || message.pushName || message.notifyName || message._data?.notifyName || null;
  const senderPicture = avatarUrl(participant.picture || message.participantPicture || message.authorPicture || message.profilePictureUrl, providerUrl);
  const rawPreview = message.linkPreview || message.preview || message._data?.linkPreview || (message._data?.links?.[0] ? { url: message._data.links[0].link || message._data.links[0].url || message.body || message.text || "", title: message._data.title || "", description: message._data.description || message._data.text || "", image: message._data.botReelPluginThumbnailCdnUrl || message._data.thumbnailHQ || message._data.thumbnailUrl || null } : null);
  // Always pass URL if available so client can fetch OG data; only omit if no URL at all
  const hasUrl = rawPreview && (rawPreview.url || rawPreview.canonicalUrl || rawPreview.link);
  const hasContent = rawPreview && (rawPreview.title || rawPreview.titleText || rawPreview.description || rawPreview.desc || rawPreview.thumbnail || rawPreview.thumbnailUrl || rawPreview.image || rawPreview.imageUrl);
  const timestamp = normalizedTimestamp(message.timestamp || message._data?.timestamp || 0);
  const resolveMediaUrl = value => value ? avatarUrl(value, providerUrl) : null;
  return {
    id: providerMessageId(message.id) || derivedMessageId(message, timestamp, senderId), timestamp, fromMe: Boolean(message.fromMe), body: message.body || '', text: message.text || '', system: systemMessageView(message), replyTo: replyView(message.replyTo || message.quotedMsg || message._data?.replyTo),
    hasMedia: Boolean(message.hasMedia), media: message.media ? { url: resolveMediaUrl(message.media.url), mimetype: message.media.mimetype || null, filename: message.media.filename || null } : null, mediaUrl: resolveMediaUrl(message.mediaUrl), vCards: Array.isArray(message.vCards) ? message.vCards : (Array.isArray(message._data?.vCards) ? message._data.vCards : []), sender: senderId ? { id: senderId, name: senderName, picture: senderPicture } : null, linkPreview: hasUrl ? { url: rawPreview.url || rawPreview.canonicalUrl || rawPreview.link || message.body || message.text || '', title: hasContent ? (rawPreview.title || rawPreview.titleText || '') : '', description: hasContent ? (rawPreview.description || rawPreview.desc || '') : '', image: hasContent ? (rawPreview.thumbnail || rawPreview.thumbnailUrl || rawPreview.image || rawPreview.imageUrl || null) : null } : null, ack: message.ack, ackName: message.ackName,
  };
}
