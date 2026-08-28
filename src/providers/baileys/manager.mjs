/**
 * Owns the live WhatsApp connectivity: one Baileys socket per Gakai account,
 * its auth-state persistence, and the event wiring that keeps the local
 * store (store.mjs) in sync with what WhatsApp actually reports. This is the
 * direct replacement for the old provider's REST session/chat/message API —
 * everything server.mjs used to reach over HTTP now happens here, in-process.
 */
import {
  makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, jidDecode, jidNormalizedUser,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { createMediaStore } from './media.mjs';
import { createBoundedCache } from '../../lib/lru-cache.mjs';
import { messageView, chatOverview as domainChatOverview, reactionView, revokeView, editView, ackStatusRank, bareJidUser, isGroupChatId, isLidJid, isSameIdentity } from '../../domain/message.mjs';

const RECONNECT_DELAY_MS = 3000;

// Gakai's own presence vocabulary ('typing'/'recording'/'paused') maps onto
// Baileys' WAPresence type ('composing'/'recording'/'paused'/'available'/
// 'unavailable') — only the outbound-publish direction needs translating;
// inbound presence.update events are relayed through unchanged.
const PRESENCE_TO_WA = { typing: 'composing', recording: 'recording', paused: 'paused' };

export function createBaileysProvider({ db, sessionsDir, mediaCacheDir, logLevel, onEvent }) {
  const store = openStore(db);
  const logger = pino({ level: logLevel || 'silent' });
  const media = createMediaStore({ cacheDir: mediaCacheDir, logger });
  const accounts = new Map(); // accountId -> { sock, status, qr, me, saveCreds, reconnecting }
  // A contact/chat with genuinely no photo set would otherwise be re-fetched
  // from WhatsApp on every single lookup, since store.setContactPicture only
  // ever persists a truthy result. This remembers a negative result for a
  // while so a photo-less chat doesn't cost a live request on every poll.
  const noPictureCache = createBoundedCache({ limit: 2000, ttlMs: 30 * 60 * 1000 });
  // Group participant lists back the composer's @-mention menu. groupMetadata
  // is a live WhatsApp request, so a short TTL cache keeps typing "@" in a
  // busy group from fanning out one request per keystroke while still picking
  // up membership changes within a few minutes.
  const groupParticipantsCache = createBoundedCache({ limit: 500, ttlMs: 5 * 60 * 1000 });

  const accountDir = accountId => join(sessionsDir, accountId);

  function setStatus(accountId, status) {
    const entry = accounts.get(accountId);
    if (entry) entry.status = status;
  }

  function overviewFromMessage(normalized) {
    return { body: normalized.body, text: normalized.text, timestamp: normalized.timestamp, hasMedia: normalized.hasMedia, system: normalized.system };
  }

  function wireEvents(accountId, entry) {
    const { sock } = entry;

    // A live WhatsApp event handler throwing synchronously is an uncaught
    // exception at the process level — Node's default response to that is
    // to crash the entire server, taking every account and every in-flight
    // HTTP request down with it (this actually happened once: a malformed
    // reply payload crashed the process mid-message). One bad message must
    // never do that — log it and keep the connection alive instead.
    const safe = (name, handler) => async (...args) => {
      try { await handler(...args); }
      catch (error) { logger.error({ error: error.message, stack: error.stack, accountId, event: name }, 'Provider event handler failed'); }
    };

    sock.ev.on('creds.update', entry.saveCreds);

    sock.ev.on('connection.update', safe('connection.update', async update => {
      if (update.qr) { entry.qr = update.qr; entry.status = 'SCAN_QR_CODE'; }
      if (update.connection === 'open') {
        entry.qr = null;
        entry.status = 'WORKING';
        entry.me = sock.user ? { id: sock.user.id, name: sock.user.name || sock.user.notify || null } : null;
        // Fold any conversation that a previous session split across a
        // phone-JID chat and a LID chat back into one. Best-effort.
        reconcileLidChats(accountId).catch(error => logger.warn({ error: error.message, accountId }, 'LID chat reconciliation failed'));
      }
      if (update.connection === 'connecting' && !entry.qr) entry.status = 'STARTING';
      if (update.connection === 'close') {
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        accounts.delete(accountId);
        if (loggedOut) {
          // The phone unlinked this device — the stored auth state is dead.
          // Wipe it so the next start issues a fresh QR instead of retrying
          // credentials WhatsApp has already invalidated.
          await rm(accountDir(accountId), { recursive: true, force: true }).catch(() => {});
          return;
        }
        // Any other close (network blip, server-initiated restart) is
        // expected to recover on reconnect with the same credentials.
        if (entry.reconnecting) return;
        entry.reconnecting = true;
        setTimeout(() => { startAccount(accountId, { label: entry.label }).catch(error => logger.error({ error: error.message, accountId }, 'Reconnect failed')); }, RECONNECT_DELAY_MS);
      }
    }));

    sock.ev.on('messaging-history.set', safe('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
      ingestLidMappings(accountId, lidPnMappings);
      learnFromContacts(accountId, contacts);
      store.upsertChats(accountId, (chats || []).map(chat => ({ ...chat, id: canonicalChatId(accountId, chat.id) })));
      store.upsertContacts(accountId, (contacts || []).map(mapContact));
      ingestMessages(accountId, messages || [], { live: false });
    }));

    sock.ev.on('lid-mapping.update', safe('lid-mapping.update', mapping => {
      ingestLidMappings(accountId, Array.isArray(mapping) ? mapping : [mapping]);
    }));

    sock.ev.on('chats.upsert', safe('chats.upsert', chats => store.upsertChats(accountId, chats.map(chat => ({ ...chat, id: canonicalChatId(accountId, chat.id) })))));
    sock.ev.on('chats.update', safe('chats.update', updates => store.upsertChats(accountId, updates.filter(u => u.id).map(chat => ({ ...chat, id: canonicalChatId(accountId, chat.id) })))));
    sock.ev.on('contacts.upsert', safe('contacts.upsert', contacts => { learnFromContacts(accountId, contacts); store.upsertContacts(accountId, contacts.map(mapContact)); }));
    sock.ev.on('contacts.update', safe('contacts.update', updates => { learnFromContacts(accountId, updates); store.upsertContacts(accountId, updates.filter(u => u.id).map(mapContact)); }));

    sock.ev.on('messages.upsert', safe('messages.upsert', ({ messages, type }) => {
      ingestMessages(accountId, messages, { live: type === 'notify' });
    }));

    // Delivery/read progress for messages this account sent. Baileys reports it
    // as `update.status` (a proto.WebMessageInfo.Status enum) — fold it onto the
    // stored raw message so the next read of the page shows the right tick.
    sock.ev.on('messages.update', safe('messages.update', updates => {
      for (const { key, update } of updates || []) {
        if (!key?.id || !key.fromMe || update?.status == null) continue;
        const chatId = canonicalChatId(accountId, key.remoteJid);
        const raw = store.getMessageById(accountId, chatId, key.id) || store.getMessageById(accountId, null, key.id);
        if (!raw) continue;
        if (ackStatusRank(update.status) <= ackStatusRank(raw.status)) continue;
        raw.status = update.status;
        const normalized = messageView(raw, { accountId, chatId });
        store.upsertMessages(accountId, [{ chatId, messageId: normalized.id, timestamp: normalized.timestamp, fromMe: true, waMessage: raw, overviewMessage: overviewFromMessage(normalized) }]);
      }
    }));

    sock.ev.on('presence.update', safe('presence.update', ({ id: chatId, presences }) => {
      onEvent?.('presence', { accountId, chatId, presences });
    }));
  }

  function mapContact(contact) {
    return { id: contact.id, name: contact.name || contact.notify || contact.verifiedName || null, picture: null, phone: contact.id?.endsWith('@s.whatsapp.net') ? contact.id.slice(0, -'@s.whatsapp.net'.length) : null };
  }

  // A contact can carry both its phone-number JID and its LID — record the
  // pairing so conversations stay unified (see learnLidPn).
  function learnFromContacts(accountId, contacts) {
    for (const contact of contacts || []) {
      if (contact?.id && contact?.lid) learnLidPn(accountId, contact.id, contact.lid, { silent: true });
    }
  }

  function normJid(jid) {
    try { return jidNormalizedUser(String(jid || '')); } catch { return String(jid || ''); }
  }

  // WhatsApp now addresses a 1:1 conversation by either the contact's
  // phone-number JID (<n>@s.whatsapp.net) or its LID (<n>@lid) depending on
  // context, which made the same person show up as two chats. Everything Gakai
  // stores keys a DM by the phone JID; this resolves any incoming id to that
  // canonical form when the mapping is known (falling back to the id as-is).
  function canonicalChatId(accountId, jid) {
    const raw = String(jid || '');
    if (!raw || isGroupChatId(raw) || !isLidJid(raw)) return raw;
    return store.resolveLid(accountId, normJid(raw)) || raw;
  }

  // Record a lid<->phone-number pairing (order-agnostic) and immediately fold
  // any chat that was created under the LID into the canonical phone-JID chat.
  function learnLidPn(accountId, a, b, { silent = false } = {}) {
    const na = normJid(a), nb = normJid(b);
    if (!na || !nb || na === nb) return;
    let lid, pn;
    if (isLidJid(na) && !isLidJid(nb)) { lid = na; pn = nb; }
    else if (isLidJid(nb) && !isLidJid(na)) { lid = nb; pn = na; }
    else return;
    if (store.resolveLid(accountId, lid) === pn) return;
    store.setLidMapping(accountId, lid, pn);
    if (store.chatExists(accountId, lid)) {
      store.mergeChat(accountId, lid, pn);
      if (!silent) logger.info({ accountId, lid, pn }, 'Merged a LID chat into its phone-number chat');
    }
  }

  function ingestLidMappings(accountId, pairs) {
    for (const pair of pairs || []) {
      if (pair?.lid && pair?.pn) learnLidPn(accountId, pair.pn, pair.lid, { silent: true });
    }
  }

  // A message key carries the "other" addressing form in remoteJidAlt (and, for
  // group participants, participantAlt) — the cheapest place to learn a mapping.
  function learnFromKey(accountId, key) {
    if (!key) return;
    if (key.remoteJid && key.remoteJidAlt) learnLidPn(accountId, key.remoteJid, key.remoteJidAlt, { silent: true });
    if (key.participant && key.participantAlt) learnLidPn(accountId, key.participant, key.participantAlt, { silent: true });
  }

  // Startup sweep: for any chat still keyed by a LID, ask Baileys for the
  // phone-number JID and merge. Covers conversations split before Gakai
  // learned to keep them unified.
  async function reconcileLidChats(accountId) {
    const entry = accounts.get(accountId);
    if (!entry) return;
    for (const chatId of store.listChatIds(accountId)) {
      if (!isLidJid(chatId)) continue;
      let pn = store.resolveLid(accountId, normJid(chatId));
      if (!pn) {
        pn = await entry.sock.signalRepository?.lidMapping?.getPNForLID?.(chatId).catch(() => null);
        if (pn && !isLidJid(pn)) store.setLidMapping(accountId, normJid(chatId), normJid(pn));
      }
      if (pn && !isLidJid(pn)) store.mergeChat(accountId, chatId, normJid(pn));
    }
  }

  function ingestMessages(accountId, messages, { live }) {
    const toStore = [];
    for (const raw of messages) {
      // One malformed message (an unexpected payload shape, a field WhatsApp
      // changed) must not drop every other message in the same batch — skip
      // and log just that one.
      try {
        if (!raw.key?.remoteJid) continue;
        // Learn any lid<->phone pairing this message reveals, then key it by
        // the canonical (phone-JID) chat so one person is always one thread.
        learnFromKey(accountId, raw.key);
        const chatId = canonicalChatId(accountId, raw.key.remoteJid);

        const reaction = reactionView(raw);
        if (reaction) { store.applyReaction(accountId, reaction); continue; }

        const revoke = revokeView(raw);
        if (revoke?.targetMessageId) { store.deleteMessage(accountId, chatId, revoke.targetMessageId); continue; }

        const edit = editView(raw);
        if (edit?.targetMessageId) { store.applyEdit(accountId, chatId, edit.targetMessageId, edit.newText); continue; }

        const normalized = messageView(raw, { accountId, chatId });
        toStore.push({ chatId, messageId: normalized.id, timestamp: normalized.timestamp, fromMe: normalized.fromMe, waMessage: raw, overviewMessage: overviewFromMessage(normalized) });

        if (live && !normalized.fromMe) onEvent?.('message', { accountId, chatId, message: normalized, raw });
      } catch (error) {
        logger.error({ error: error.message, stack: error.stack, accountId, messageId: raw.key?.id }, 'Failed to normalize an inbound message; skipping just this one');
      }
    }
    if (toStore.length) store.upsertMessages(accountId, toStore);
  }

  async function startAccount(accountId, { label } = {}) {
    const existing = accounts.get(accountId);
    if (existing) return existing;
    await mkdir(accountDir(accountId), { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(accountDir(accountId));
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, logger, auth: state, generateHighQualityLinkPreview: true, syncFullHistory: false });
    const entry = { sock, status: 'STARTING', qr: null, me: null, label: label || null, saveCreds, reconnecting: false };
    accounts.set(accountId, entry);
    wireEvents(accountId, entry);
    return entry;
  }

  async function restartAccount(accountId) {
    const existing = accounts.get(accountId);
    const label = existing?.label || null;
    if (existing) { try { existing.sock.end(undefined); } catch {} accounts.delete(accountId); }
    return startAccount(accountId, { label });
  }

  async function deleteAccount(accountId) {
    const existing = accounts.get(accountId);
    if (existing) { try { existing.sock.logout(); } catch {} try { existing.sock.end(undefined); } catch {} accounts.delete(accountId); }
    await rm(accountDir(accountId), { recursive: true, force: true }).catch(() => {});
    store.deleteAccountData(accountId);
  }

  function listAccounts() {
    return [...accounts.entries()].map(([id, entry]) => accountSnapshot(id, entry));
  }

  function accountSnapshot(id, entry) {
    return {
      id,
      status: entry.status,
      phone: entry.me?.id && jidDecode(entry.me.id)?.server === 's.whatsapp.net' ? bareJidUser(entry.me.id) : null,
      profile: entry.me?.name || null,
      ownJid: entry.me?.id || null,
    };
  }

  function getAccount(accountId) {
    const entry = accounts.get(accountId);
    return entry ? accountSnapshot(accountId, entry) : null;
  }

  async function getQr(accountId) {
    const entry = accounts.get(accountId);
    if (!entry?.qr) return null;
    const dataUrl = await QRCode.toDataURL(entry.qr, { margin: 1, width: 320 });
    return { qr: dataUrl };
  }

  function requireSocket(accountId) {
    const entry = accounts.get(accountId);
    if (!entry) throw Object.assign(new Error('Account is not connected'), { status: 409 });
    return entry;
  }

  async function sendText(accountId, chatId, text, { quotedMessageId, mentions } = {}) {
    const { sock } = requireSocket(accountId);
    // Send to (and store under) the canonical phone-JID chat, even if the
    // caller still holds a LID id for this conversation.
    const target = canonicalChatId(accountId, chatId);
    const quoted = quotedMessageId ? store.getMessageById(accountId, target, quotedMessageId) : null;
    const content = Array.isArray(mentions) && mentions.length ? { text, mentions } : { text };
    const sent = await sock.sendMessage(target, content, quoted ? { quoted } : undefined);
    learnFromKey(accountId, sent?.key);
    const normalized = messageView(sent, { accountId, chatId: target });
    store.upsertMessages(accountId, [{ chatId: target, messageId: normalized.id, timestamp: normalized.timestamp, fromMe: true, waMessage: sent, overviewMessage: overviewFromMessage(normalized) }]);
    return normalized;
  }

  // Pick the Baileys media content shape from the mimetype unless the caller
  // forces `kind` (the composer forces 'audio' with ptt for a voice note).
  function mediaKindFor(mimetype, forced) {
    if (forced) return forced;
    const type = String(mimetype || '').toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    return 'document';
  }

  async function sendMedia(accountId, chatId, { buffer, mimetype, filename, caption, kind, ptt } = {}, { quotedMessageId } = {}) {
    const { sock } = requireSocket(accountId);
    if (!buffer || !buffer.length) throw Object.assign(new Error('No file data received'), { status: 400 });
    const target = canonicalChatId(accountId, chatId);
    const quoted = quotedMessageId ? store.getMessageById(accountId, target, quotedMessageId) : null;
    const resolvedKind = mediaKindFor(mimetype, kind);
    const trimmedCaption = caption ? String(caption).slice(0, 1024) : '';
    let content;
    if (resolvedKind === 'image') content = { image: buffer, mimetype: mimetype || 'image/jpeg', ...(trimmedCaption ? { caption: trimmedCaption } : {}) };
    else if (resolvedKind === 'video') content = { video: buffer, mimetype: mimetype || 'video/mp4', ...(trimmedCaption ? { caption: trimmedCaption } : {}) };
    else if (resolvedKind === 'audio') content = { audio: buffer, mimetype: mimetype || 'audio/ogg; codecs=opus', ptt: Boolean(ptt) };
    else content = { document: buffer, mimetype: mimetype || 'application/octet-stream', fileName: filename || 'file', ...(trimmedCaption ? { caption: trimmedCaption } : {}) };
    const sent = await sock.sendMessage(target, content, quoted ? { quoted } : undefined);
    learnFromKey(accountId, sent?.key);
    const normalized = messageView(sent, { accountId, chatId: target });
    store.upsertMessages(accountId, [{ chatId: target, messageId: normalized.id, timestamp: normalized.timestamp, fromMe: true, waMessage: sent, overviewMessage: overviewFromMessage(normalized) }]);
    return normalized;
  }

  async function editMessage(accountId, chatId, messageId, text) {
    const { sock } = requireSocket(accountId);
    const target = canonicalChatId(accountId, chatId);
    const raw = store.getMessageById(accountId, target, messageId) || store.getMessageById(accountId, null, messageId);
    if (!raw?.key) throw Object.assign(new Error('Message not found'), { status: 404 });
    if (!raw.key.fromMe) throw Object.assign(new Error('You can only edit your own messages'), { status: 403 });
    const trimmed = String(text || '').trim();
    if (!trimmed) throw Object.assign(new Error('An edited message cannot be empty'), { status: 400 });
    await sock.sendMessage(target, { text: trimmed, edit: raw.key });
    store.applyEdit(accountId, target, messageId, trimmed);
    const updated = store.getMessageById(accountId, target, messageId);
    return messageView(updated, { accountId, chatId: target });
  }

  async function forwardMessage(accountId, fromChatId, messageId, toChatId) {
    const { sock } = requireSocket(accountId);
    const source = store.getMessageById(accountId, canonicalChatId(accountId, fromChatId), messageId)
      || store.getMessageById(accountId, null, messageId);
    if (!source) throw Object.assign(new Error('Original message not found'), { status: 404 });
    const target = canonicalChatId(accountId, toChatId);
    const sent = await sock.sendMessage(target, { forward: source });
    learnFromKey(accountId, sent?.key);
    const normalized = messageView(sent, { accountId, chatId: target });
    store.upsertMessages(accountId, [{ chatId: target, messageId: normalized.id, timestamp: normalized.timestamp, fromMe: true, waMessage: sent, overviewMessage: overviewFromMessage(normalized) }]);
    return { chatId: target, message: normalized };
  }

  async function setReaction(accountId, chatId, messageId, reaction) {
    const { sock, me } = requireSocket(accountId);
    chatId = canonicalChatId(accountId, chatId);
    const target = store.getMessageById(accountId, chatId, messageId);
    const key = target?.key || { remoteJid: chatId, id: messageId, fromMe: false };
    const targetChatId = chatId || key.remoteJid;
    if (!targetChatId) throw Object.assign(new Error('Could not determine which chat this message belongs to'), { status: 404 });
    await sock.sendMessage(targetChatId, { react: { text: reaction || '', key } });
    const senderId = me?.id || targetChatId;
    store.applyReaction(accountId, { targetMessageId: messageId, senderId, reaction: reaction || '' });
  }

  async function deleteMessage(accountId, chatId, messageId) {
    const { sock } = requireSocket(accountId);
    chatId = canonicalChatId(accountId, chatId);
    const target = store.getMessageById(accountId, chatId, messageId);
    const key = target?.key || { remoteJid: chatId, id: messageId, fromMe: true };
    await sock.sendMessage(chatId, { delete: key });
    store.deleteMessage(accountId, chatId, messageId);
  }

  async function deleteChat(accountId, chatId) {
    chatId = canonicalChatId(accountId, chatId);
    const entry = accounts.get(accountId);
    if (entry) {
      try {
        const [lastMessage] = store.getMessagesPage(accountId, chatId, { limit: 1 });
        await entry.sock.chatModify({ delete: true, lastMessages: lastMessage ? [{ key: lastMessage.key, messageTimestamp: lastMessage.messageTimestamp }] : [] }, chatId);
      } catch (error) { logger.warn({ error: error.message, accountId, chatId }, 'Remote chat delete failed; removing locally anyway'); }
    }
    // The local store is authoritative for what the inbox shows, so the
    // chat disappears from Gakai even if the remote delete above failed.
    store.deleteChat(accountId, chatId);
  }

  async function markChatRead(accountId, chatId) {
    chatId = canonicalChatId(accountId, chatId);
    const entry = accounts.get(accountId);
    if (entry) {
      const recent = store.getMessagesPage(accountId, chatId, { limit: 10 }).filter(m => !m.key?.fromMe && m.key);
      if (recent.length) await entry.sock.readMessages(recent.map(m => m.key)).catch(() => {});
    }
    store.setChatUnread(accountId, chatId, 0);
  }

  // Pin / mute / archive. `value` is a boolean for pin/archive, a duration in
  // seconds (0 = unmute) for mute. Baileys' chatModify is best-effort; the
  // local store stays authoritative for what the inbox renders, same as
  // deleteChat.
  async function setChatState(accountId, chatId, action, value) {
    chatId = canonicalChatId(accountId, chatId);
    const entry = accounts.get(accountId);
    let flags;
    if (action === 'pin') flags = { pinned: Boolean(value) };
    else if (action === 'archive') flags = { archived: Boolean(value) };
    else if (action === 'mute') {
      const seconds = Number(value) || 0;
      flags = { mutedUntil: seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0 };
    } else throw Object.assign(new Error('Unknown chat action'), { status: 400 });

    if (entry) {
      try {
        if (action === 'pin') await entry.sock.chatModify({ pin: Boolean(value) }, chatId);
        else if (action === 'mute') await entry.sock.chatModify({ mute: Number(value) > 0 ? Date.now() + Number(value) * 1000 : null }, chatId);
        else if (action === 'archive') {
          const [lastMessage] = store.getMessagesPage(accountId, chatId, { limit: 1 });
          await entry.sock.chatModify({ archive: Boolean(value), lastMessages: lastMessage ? [{ key: lastMessage.key, messageTimestamp: lastMessage.messageTimestamp }] : [] }, chatId);
        }
      } catch (error) { logger.warn({ error: error.message, accountId, chatId, action }, 'Remote chatModify failed; applying locally anyway'); }
    }
    store.setChatFlags(accountId, chatId, flags);
    return enrichedOverviewFor(accountId, chatId);
  }

  function enrichedOverviewFor(accountId, chatId) {
    const [row] = store.getChatsOverview(accountId, 1000).filter(chat => chat.id === chatId);
    if (row) return domainChatOverview(row);
    const contact = store.getContact(accountId, chatId);
    return domainChatOverview({ id: chatId, name: contact?.name || null, picture: contact?.picture || null, unreadCount: 0, lastMessageTimestamp: 0, lastMessage: null });
  }

  async function subscribePresence(accountId, chatId) {
    const { sock } = requireSocket(accountId);
    await sock.presenceSubscribe(canonicalChatId(accountId, chatId)).catch(() => {});
  }

  async function publishPresence(accountId, chatId, presence) {
    const { sock } = requireSocket(accountId);
    await sock.sendPresenceUpdate(PRESENCE_TO_WA[presence] || 'paused', canonicalChatId(accountId, chatId)).catch(() => {});
  }

  // `namesOnly` skips the live profilePictureUrl() lookup and returns just
  // whatever name/phone/picture is already in the local store — the inbox
  // list's first paint uses this so it never blocks on ~40 WhatsApp
  // round-trips; the picture is then filled in lazily (getChatPictures).
  async function getContact(accountId, contactId, { namesOnly = false } = {}) {
    const cached = store.getContact(accountId, contactId);
    const entry = accounts.get(accountId);
    const cacheKey = `${accountId}:${contactId}`;
    let picture = cached?.picture || null;
    if (!namesOnly && !picture && entry && !noPictureCache.get(cacheKey)) {
      picture = (await entry.sock.profilePictureUrl(contactId, 'preview').catch(() => null)) || null;
      if (picture) store.setContactPicture(accountId, contactId, picture);
      else noPictureCache.set(cacheKey, true);
    }
    return {
      id: contactId,
      phone: cached?.phone || (jidDecode(contactId)?.server === 's.whatsapp.net' ? bareJidUser(contactId) : null),
      name: cached?.name || null,
      picture,
    };
  }

  function getContacts(accountId) { return store.getContacts(accountId); }

  // The @-mention menu's data source. Returns the other members of a group
  // chat as { id (jid), name, number }, where `number` is the bare digits the
  // composer writes into the message text as "@<number>" and `id` is the jid
  // Baileys expects in the outbound `mentions` array. The account's own entry
  // is filtered out — you don't mention yourself. Non-groups and any failure
  // return [] so the composer simply shows no menu.
  async function getGroupParticipants(accountId, chatId) {
    if (!isGroupChatId(chatId)) return [];
    const cacheKey = `${accountId}:${chatId}`;
    const cached = groupParticipantsCache.get(cacheKey);
    if (cached) return cached;
    const entry = accounts.get(accountId);
    if (!entry) return [];
    let metadata;
    try { metadata = await entry.sock.groupMetadata(chatId); }
    catch (error) { logger.warn({ error: error.message, accountId, chatId }, 'Group metadata fetch failed'); return []; }
    const ownJid = entry.me?.id || null;
    const participants = (metadata?.participants || []).map(participant => {
      const rawId = participant.id || participant.jid;
      if (!rawId) return null;
      // A LID-only participant is resolved to its phone jid where Gakai has
      // already observed the mapping; otherwise the lid is carried through as
      // both id and number, the same safe fallback used elsewhere.
      const resolvedId = isLidJid(rawId) ? resolveLid(accountId, rawId) : rawId;
      const contact = store.getContact(accountId, resolvedId) || store.getContact(accountId, rawId);
      const number = jidDecode(resolvedId)?.server === 's.whatsapp.net' ? bareJidUser(resolvedId) : bareJidUser(rawId);
      const isMe = ownJid && (isSameIdentity(rawId, ownJid) || isSameIdentity(resolvedId, ownJid));
      return { id: resolvedId, number, name: contact?.name || participant.name || participant.notify || (number ? `+${number}` : bareJidUser(rawId)), isMe: Boolean(isMe) };
    }).filter(participant => participant && !participant.isMe && participant.number)
      .map(({ isMe, ...participant }) => participant);
    groupParticipantsCache.set(cacheKey, participants);
    return participants;
  }

  // Best-effort: WhatsApp's LID (linked-device anonymous id) → phone-number
  // jid mapping is only available once Gakai has actually observed it
  // (a contact/message event carrying both forms). Without a stored mapping
  // yet, the lid itself is returned unresolved — the same safe fallback the
  // old provider integration used when its own resolution failed.
  function resolveLid(accountId, lid) {
    return store.resolveLid(accountId, lid) || lid;
  }

  // Is this number reachable on WhatsApp? Baileys' onWhatsApp() takes bare
  // digits or a jid and returns the canonical jid plus an `exists` flag.
  async function checkOnWhatsApp(accountId, phone) {
    const { sock } = requireSocket(accountId);
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (digits.length < 6 || digits.length > 15) throw Object.assign(new Error('Enter a valid phone number in international format'), { status: 400 });
    const [result] = (await sock.onWhatsApp(digits)) || [];
    return { exists: Boolean(result?.exists), jid: result?.jid || `${digits}@s.whatsapp.net` };
  }

  // Open a brand-new 1:1 conversation: verify the number is on WhatsApp, make
  // sure a (canonical) chat row exists, and hand back the same overview shape
  // the inbox list consumes so the client can drop it straight in.
  async function startConversation(accountId, phone) {
    const { exists, jid } = await checkOnWhatsApp(accountId, phone);
    if (!exists) throw Object.assign(new Error('That number is not on WhatsApp'), { status: 404 });
    const chatId = canonicalChatId(accountId, jid);
    store.ensureChat(accountId, chatId);
    const contact = store.getContact(accountId, chatId);
    return domainChatOverview({
      id: chatId,
      name: contact?.name || null,
      picture: contact?.picture || null,
      unreadCount: 0,
      lastMessageTimestamp: Math.floor(Date.now() / 1000),
      lastMessage: null,
    });
  }

  async function getChatsOverview(accountId) {
    const rows = store.getChatsOverview(accountId, 200);
    return rows.map(row => {
      if (!row.name) {
        const contact = store.getContact(accountId, row.id);
        if (contact?.name) row = { ...row, name: contact.name };
        if (!row.picture && contact?.picture) row = { ...row, picture: contact.picture };
      }
      return domainChatOverview(row);
    });
  }

  async function getMessages(accountId, chatId, { limit = 20, before, downloadMedia = false } = {}) {
    chatId = canonicalChatId(accountId, chatId);
    const rows = store.getMessagesPage(accountId, chatId, { limit, before });
    const views = rows.map(raw => messageView(raw, { accountId, chatId }));
    if (downloadMedia) await hydrateMedia(accountId, chatId, rows, views);
    return views.map(view => withReaction(accountId, view));
  }

  async function getMessage(accountId, chatId, messageId) {
    chatId = canonicalChatId(accountId, chatId);
    const raw = store.getMessageById(accountId, chatId, messageId);
    if (!raw) return null;
    const view = messageView(raw, { accountId, chatId });
    if (view.hasMedia) await hydrateMedia(accountId, chatId, [raw], [view]);
    return withReaction(accountId, view);
  }

  function withReaction(accountId, view) {
    const reaction = store.getReaction(accountId, view.id);
    return reaction ? { ...view, reaction } : view;
  }

  // Pre-warms the media cache so `mediaUrl` resolves without a client
  // round-trip; the response shape is unchanged either way since media is
  // always served through /api/app/message-media, never inlined.
  async function hydrateMedia(accountId, chatId, rows, views) {
    const entry = accounts.get(accountId);
    if (!entry) return;
    await Promise.all(rows.map(async (raw, index) => {
      const view = views[index];
      if (!view.hasMedia) return;
      try { await media.download(accountId, view.id, raw, entry.sock, view.media?.mimetype); } catch (error) { logger.warn({ error: error.message, accountId, messageId: view.id }, 'Media pre-hydration failed'); }
    }));
  }

  async function downloadMedia(accountId, chatId, messageId) {
    chatId = canonicalChatId(accountId, chatId);
    const raw = store.getMessageById(accountId, chatId, messageId);
    if (!raw) return null;
    const view = messageView(raw, { accountId, chatId });
    if (!view.hasMedia) return null;
    const entry = requireSocket(accountId);
    return media.download(accountId, messageId, raw, entry.sock, view.media?.mimetype);
  }

  async function shutdown() {
    for (const [, entry] of accounts) { try { entry.sock.end(undefined); } catch {} }
  }

  return {
    startAccount, restartAccount, deleteAccount, listAccounts, getAccount, getQr,
    sendText, sendMedia, forwardMessage, editMessage, setReaction, deleteMessage, deleteChat, markChatRead, setChatState,
    subscribePresence, publishPresence,
    getContact, getContacts, resolveLid, getGroupParticipants,
    checkOnWhatsApp, startConversation,
    getChatsOverview, getMessages, getMessage, downloadMedia,
    shutdown,
  };
}
