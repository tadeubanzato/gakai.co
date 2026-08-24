/**
 * Provider-neutral normalization: Baileys' WhatsApp payload shapes in,
 * Gakai's stable message/chat view model out. Every field this module
 * returns is what `server.mjs` and the browser client have always consumed
 * — only the provider-specific shapes feeding it changed.
 */
import { createHash } from 'node:crypto';
import { getContentType, normalizeMessageContent, WAMessageStubType, jidDecode, areJidsSameUser, isJidGroup, isLidUser } from '@whiskeysockets/baileys';

// Baileys' own guidance: never split a JID with a suffix regex or compare
// JIDs with `===` — device suffixes (":2") and the phone-number/LID duality
// make both unreliable. These wrap the library's real decoder/classifiers so
// every call site (here and in server.mjs, which stays provider-neutral and
// never imports Baileys directly) goes through one correct implementation.
export function bareJidUser(jid) {
  return jidDecode(String(jid || ''))?.user || String(jid || '');
}

export function isGroupChatId(chatId) {
  return isJidGroup(String(chatId || ''));
}

export function isLidJid(jid) {
  return isLidUser(String(jid || ''));
}

export function isSameIdentity(a, b) {
  if (!a || !b) return false;
  try { return areJidsSameUser(a, b); } catch { return false; }
}

// WhatsApp timestamps are Unix seconds, but protobuf's Long type (used for
// 64-bit fields) doesn't stringify or coerce to Number cleanly — it needs an
// explicit toNumber(). Every timestamp field on a Baileys message goes
// through this.
export function normalizedTimestamp(value) {
  if (value && typeof value === 'object' && typeof value.toNumber === 'function') value = value.toNumber();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

// A stored chat/contact avatar is a direct WhatsApp CDN URL
// (pps.whatsapp.net) fetched via sock.profilePictureUrl() — WhatsApp's own
// CDN, meant to be loaded directly by any client, not a Gakai-internal
// address. Message media is different (see messageMediaUrl below): it has
// no standalone fetchable URL at all, encrypted or otherwise, so it's always
// proxied through Gakai's own endpoint instead.
export function avatarUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}

// Message media (images, video, audio, documents, stickers) has no
// standalone URL — Baileys requires the full message object plus its keys to
// decrypt it, so it can only ever be served by Gakai's own on-demand
// download endpoint, never linked to directly.
export function messageMediaUrl(accountId, chatId, messageId) {
  return `/api/app/media?accountId=${encodeURIComponent(accountId)}&chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(messageId)}`;
}

export function chatTimestamp(chat) {
  return normalizedTimestamp(chat.lastMessageTimestamp ?? chat.conversationTimestamp ?? chat.timestamp ?? 0);
}

// A chat with a real message behind its timestamp, as opposed to metadata
// churn (a read-state sync, an app-state patch) that can also bump
// conversationTimestamp with nothing new actually sent or received.
export function hasMessageContent(chat) {
  const last = chat.lastMessage;
  if (!last) return false;
  return Boolean(last.body || last.text || last.hasMedia || last.system?.kind === 'call');
}

export function chatOverview(chat) {
  return {
    id: chat.id,
    name: chat.name || null,
    picture: avatarUrl(chat.picture),
    unreadCount: Number(chat.unreadCount || 0) || 0,
    timestamp: chatTimestamp(chat),
    lastMessage: chat.lastMessage ? {
      body: chat.lastMessage.body || '',
      text: chat.lastMessage.text || '',
      timestamp: normalizedTimestamp(chat.lastMessage.timestamp || 0),
      hasMedia: Boolean(chat.lastMessage.hasMedia),
      system: chat.lastMessage.system || null,
    } : null,
  };
}

const CALL_STUB_TYPES = new Set([
  WAMessageStubType.CALL_MISSED_VOICE, WAMessageStubType.CALL_MISSED_VIDEO,
  WAMessageStubType.CALL_MISSED_GROUP_VOICE, WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
]);
const GROUP_EVENT_STUB_TYPES = new Set([
  WAMessageStubType.GROUP_CREATE, WAMessageStubType.GROUP_CHANGE_SUBJECT, WAMessageStubType.GROUP_CHANGE_ICON,
  WAMessageStubType.GROUP_CHANGE_INVITE_LINK, WAMessageStubType.GROUP_CHANGE_DESCRIPTION, WAMessageStubType.GROUP_CHANGE_RESTRICT,
  WAMessageStubType.GROUP_CHANGE_ANNOUNCE, WAMessageStubType.GROUP_PARTICIPANT_ADD, WAMessageStubType.GROUP_PARTICIPANT_REMOVE,
  WAMessageStubType.GROUP_PARTICIPANT_PROMOTE, WAMessageStubType.GROUP_PARTICIPANT_DEMOTE, WAMessageStubType.GROUP_PARTICIPANT_INVITE,
  WAMessageStubType.GROUP_PARTICIPANT_LEAVE, WAMessageStubType.GROUP_DELETE,
]);
const SECURITY_STUB_TYPES = new Set([WAMessageStubType.E2E_ENCRYPTED, WAMessageStubType.E2E_IDENTITY_CHANGED]);

// Baileys represents a call, a group-membership change, or an encryption
// notice as a message with no `message` payload and a numeric
// `messageStubType` instead (WhatsApp's own "system event" convention).
export function systemMessageView(waMessage) {
  const stubType = waMessage.messageStubType;
  if (!stubType) return null;
  if (CALL_STUB_TYPES.has(stubType)) {
    const video = stubType === WAMessageStubType.CALL_MISSED_VIDEO || stubType === WAMessageStubType.CALL_MISSED_GROUP_VIDEO;
    return { kind: 'call', label: `Missed ${video ? 'video' : 'voice'} call` };
  }
  if (GROUP_EVENT_STUB_TYPES.has(stubType)) return { kind: 'group-event', label: 'Group activity' };
  if (SECURITY_STUB_TYPES.has(stubType)) return { kind: 'security', label: 'Messages are end-to-end encrypted' };
  return { kind: 'system', label: 'WhatsApp system message' };
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

// Whether a message's mentioned-JID list includes the account's own
// identity — used to scope the Gakai-managed n8n reply automation to DMs and
// explicit @-mentions in a group, never every message in every group.
export function mentionsIdentity(mentionedJids, ownJid) {
  if (!ownJid || !Array.isArray(mentionedJids) || !mentionedJids.length) return false;
  const ownNumber = ownJid.replace(/@.*$/, '').replace(/^0+/, '');
  return mentionedJids.some(rawId => {
    const id = String(rawId || '');
    const number = id.replace(/@.*$/, '').replace(/^0+/, '');
    return id === ownJid || (number && number === ownNumber);
  });
}

function base64Thumbnail(bytes) {
  if (!bytes || !bytes.length) return null;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

function linkPreviewView(extendedText) {
  if (!extendedText?.canonicalUrl && !extendedText?.matchedText) return null;
  const hasContent = Boolean(extendedText.title || extendedText.description || extendedText.jpegThumbnail?.length);
  return {
    url: extendedText.canonicalUrl || extendedText.matchedText || extendedText.text || '',
    title: hasContent ? (extendedText.title || '') : '',
    description: hasContent ? (extendedText.description || '') : '',
    image: hasContent ? base64Thumbnail(extendedText.jpegThumbnail) : null,
  };
}

const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'documentWithCaptionMessage']);

function mediaView(contentType, content, accountId, chatId, messageId) {
  if (!MEDIA_TYPES.has(contentType)) return null;
  const inner = contentType === 'documentWithCaptionMessage' ? content?.message?.documentMessage : content;
  return {
    url: messageMediaUrl(accountId, chatId, messageId),
    mimetype: inner?.mimetype || null,
    filename: inner?.fileName || null,
  };
}

function bodyTextFor(contentType, content) {
  if (contentType === 'conversation') return content || '';
  if (!content) return '';
  if (contentType === 'extendedTextMessage') return content.text || '';
  if (contentType === 'imageMessage' || contentType === 'videoMessage') return content.caption || '';
  if (contentType === 'documentMessage') return content.caption || '';
  if (contentType === 'documentWithCaptionMessage') return content.message?.documentMessage?.caption || '';
  return '';
}

// WhatsApp's own read-receipt/delivery status, as Baileys' named enum
// (proto.WebMessageInfo.Status: ERROR, PENDING, SERVER_ACK, DELIVERY_ACK,
// READ, PLAYED) — the client only ever used this for display, so the name
// is what it needs.
function ackView(status) {
  if (!status) return { ack: null, ackName: null };
  const name = typeof status === 'string' ? status : String(status);
  return { ack: name, ackName: name };
}

function replyView(contextInfo, accountId, chatId) {
  const quoted = contextInfo?.quotedMessage;
  const stanzaId = contextInfo?.stanzaId;
  if (!quoted || !stanzaId) return null;
  const normalizedQuoted = normalizeMessageContent(quoted) || {};
  const quotedType = getContentType(normalizedQuoted);
  const quotedContent = quotedType ? normalizedQuoted[quotedType] : null;
  return {
    id: stanzaId,
    body: quotedType ? bodyTextFor(quotedType, quotedContent) : '',
    hasMedia: MEDIA_TYPES.has(quotedType),
    participant: contextInfo.participant || null,
  };
}

function vCardsFor(contentType, content) {
  if (contentType === 'contactMessage' && content.vcard) return [content.vcard];
  if (contentType === 'contactsArrayMessage' && Array.isArray(content.contacts)) return content.contacts.map(c => c.vcard).filter(Boolean);
  return [];
}

// When a message somehow has no id at all, derive a deterministic one from
// stable fields so the same input always produces the same id across every
// caller and render — Baileys always sets key.id in practice, but nothing
// downstream should assume that unconditionally.
function derivedMessageId(waMessage, timestamp, senderId) {
  const content = normalizeMessageContent(waMessage.message || {}) || {};
  const contentType = getContentType(content) || '';
  const seed = `${timestamp}|${waMessage.key?.fromMe ? 'out' : 'in'}|${senderId || ''}|${bodyTextFor(contentType, contentType ? content[contentType] : null)}`;
  return `derived_${createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

// waMessage: a Baileys proto.IWebMessageInfo, as stored (JSON-serialized) in
// Gakai's own local message store. accountId/chatId are needed to build the
// media-hydration URL, which has no provider-side equivalent to read off the
// message itself.
export function messageView(waMessage, { accountId, chatId } = {}) {
  const key = waMessage.key || {};
  const timestamp = normalizedTimestamp(waMessage.messageTimestamp);
  const fromMe = Boolean(key.fromMe);
  const senderId = key.participant || (!fromMe ? key.remoteJid : null) || null;
  const senderName = waMessage.pushName || null;
  const messageId = key.id || derivedMessageId(waMessage, timestamp, senderId);

  const system = systemMessageView(waMessage);
  const content = normalizeMessageContent(waMessage.message || {}) || {};
  const contentType = getContentType(content) || '';
  const inner = contentType ? content[contentType] : null;
  const contextInfo = inner?.contextInfo || null;

  const hasMedia = MEDIA_TYPES.has(contentType);
  const media = mediaView(contentType, inner, accountId, chatId, messageId);
  const { ack, ackName } = ackView(waMessage.status);
  const bodyText = inner ? bodyTextFor(contentType, inner) : '';

  return {
    id: messageId,
    timestamp,
    fromMe,
    body: bodyText,
    text: bodyText,
    system,
    replyTo: replyView(contextInfo, accountId, chatId),
    hasMedia,
    media,
    mediaUrl: hasMedia ? messageMediaUrl(accountId, chatId, messageId) : null,
    vCards: vCardsFor(contentType, inner || {}),
    sender: senderId ? { id: senderId, name: senderName, picture: null } : null,
    linkPreview: contentType === 'extendedTextMessage' ? linkPreviewView(inner) : null,
    ack, ackName,
    mentionedJids: Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [],
  };
}

// A reaction arrives from Baileys as its own message with a `reactionMessage`
// payload, not a field on the message it targets — this normalizes that
// event into {targetMessageId, chatId, senderId, reaction, reactedAt},
// mirroring how the local store keys a stored reaction.
export function reactionView(waMessage) {
  const content = normalizeMessageContent(waMessage.message || {}) || {};
  if (getContentType(content) !== 'reactionMessage') return null;
  const reaction = content.reactionMessage;
  if (!reaction) return null;
  const key = waMessage.key || {};
  return {
    targetMessageId: reaction.key?.id || null,
    chatId: key.remoteJid || reaction.key?.remoteJid || null,
    senderId: key.participant || (!key.fromMe ? key.remoteJid : null) || null,
    reaction: reaction.text || '',
    reactedAt: new Date(normalizedTimestamp(reaction.senderTimestampMs || waMessage.messageTimestamp) * 1000).toISOString(),
  };
}

// A "delete for everyone" arrives as a protocolMessage (type REVOKE), not a
// DELETE on the original message — this extracts which message it targets so
// the store can remove/tombstone it, mirroring reactionView above.
export function revokeView(waMessage) {
  const content = normalizeMessageContent(waMessage.message || {}) || {};
  if (getContentType(content) !== 'protocolMessage') return null;
  const protocolMessage = content.protocolMessage;
  if (protocolMessage?.type !== 0 && protocolMessage?.type !== 'REVOKE') return null; // proto.Message.ProtocolMessage.Type.REVOKE === 0
  return { targetMessageId: protocolMessage.key?.id || null };
}
