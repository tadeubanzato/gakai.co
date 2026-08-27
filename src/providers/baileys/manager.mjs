/**
 * Owns the live WhatsApp connectivity: one Baileys socket per Gakai account,
 * its auth-state persistence, and the event wiring that keeps the local
 * store (store.mjs) in sync with what WhatsApp actually reports. This is the
 * direct replacement for the old provider's REST session/chat/message API —
 * everything server.mjs used to reach over HTTP now happens here, in-process.
 */
import {
  makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, jidDecode,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { createMediaStore } from './media.mjs';
import { createBoundedCache } from '../../lib/lru-cache.mjs';
import { messageView, chatOverview as domainChatOverview, reactionView, revokeView, bareJidUser, isGroupChatId, isLidJid, isSameIdentity } from '../../domain/message.mjs';

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

    sock.ev.on('messaging-history.set', safe('messaging-history.set', ({ chats, contacts, messages }) => {
      store.upsertChats(accountId, chats || []);
      store.upsertContacts(accountId, (contacts || []).map(mapContact));
      ingestMessages(accountId, messages || [], { live: false });
    }));

    sock.ev.on('chats.upsert', safe('chats.upsert', chats => store.upsertChats(accountId, chats)));
    sock.ev.on('chats.update', safe('chats.update', updates => store.upsertChats(accountId, updates.filter(u => u.id))));
    sock.ev.on('contacts.upsert', safe('contacts.upsert', contacts => store.upsertContacts(accountId, contacts.map(mapContact))));
    sock.ev.on('contacts.update', safe('contacts.update', updates => store.upsertContacts(accountId, updates.filter(u => u.id).map(mapContact))));

    sock.ev.on('messages.upsert', safe('messages.upsert', ({ messages, type }) => {
      ingestMessages(accountId, messages, { live: type === 'notify' });
    }));

    sock.ev.on('presence.update', safe('presence.update', ({ id: chatId, presences }) => {
      onEvent?.('presence', { accountId, chatId, presences });
    }));
  }

  function mapContact(contact) {
    return { id: contact.id, name: contact.name || contact.notify || contact.verifiedName || null, picture: null, phone: contact.id?.endsWith('@s.whatsapp.net') ? contact.id.slice(0, -'@s.whatsapp.net'.length) : null };
  }

  function ingestMessages(accountId, messages, { live }) {
    const toStore = [];
    for (const raw of messages) {
      // One malformed message (an unexpected payload shape, a field WhatsApp
      // changed) must not drop every other message in the same batch — skip
      // and log just that one.
      try {
        const chatId = raw.key?.remoteJid;
        if (!chatId) continue;

        const reaction = reactionView(raw);
        if (reaction) { store.applyReaction(accountId, reaction); continue; }

        const revoke = revokeView(raw);
        if (revoke?.targetMessageId) { store.deleteMessage(accountId, chatId, revoke.targetMessageId); continue; }

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
    const quoted = quotedMessageId ? store.getMessageById(accountId, chatId, quotedMessageId) : null;
    const content = Array.isArray(mentions) && mentions.length ? { text, mentions } : { text };
    const sent = await sock.sendMessage(chatId, content, quoted ? { quoted } : undefined);
    const normalized = messageView(sent, { accountId, chatId });
    store.upsertMessages(accountId, [{ chatId, messageId: normalized.id, timestamp: normalized.timestamp, fromMe: true, waMessage: sent, overviewMessage: overviewFromMessage(normalized) }]);
    return normalized;
  }

  async function setReaction(accountId, chatId, messageId, reaction) {
    const { sock, me } = requireSocket(accountId);
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
    const target = store.getMessageById(accountId, chatId, messageId);
    const key = target?.key || { remoteJid: chatId, id: messageId, fromMe: true };
    await sock.sendMessage(chatId, { delete: key });
    store.deleteMessage(accountId, chatId, messageId);
  }

  async function deleteChat(accountId, chatId) {
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
    const entry = accounts.get(accountId);
    if (entry) {
      const recent = store.getMessagesPage(accountId, chatId, { limit: 10 }).filter(m => !m.key?.fromMe && m.key);
      if (recent.length) await entry.sock.readMessages(recent.map(m => m.key)).catch(() => {});
    }
    store.setChatUnread(accountId, chatId, 0);
  }

  async function subscribePresence(accountId, chatId) {
    const { sock } = requireSocket(accountId);
    await sock.presenceSubscribe(chatId).catch(() => {});
  }

  async function publishPresence(accountId, chatId, presence) {
    const { sock } = requireSocket(accountId);
    await sock.sendPresenceUpdate(PRESENCE_TO_WA[presence] || 'paused', chatId).catch(() => {});
  }

  async function getContact(accountId, contactId) {
    const cached = store.getContact(accountId, contactId);
    const entry = accounts.get(accountId);
    const cacheKey = `${accountId}:${contactId}`;
    let picture = cached?.picture || null;
    if (!picture && entry && !noPictureCache.get(cacheKey)) {
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
    const rows = store.getMessagesPage(accountId, chatId, { limit, before });
    const views = rows.map(raw => messageView(raw, { accountId, chatId }));
    if (downloadMedia) await hydrateMedia(accountId, chatId, rows, views);
    return views.map(view => withReaction(accountId, view));
  }

  async function getMessage(accountId, chatId, messageId) {
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
    sendText, setReaction, deleteMessage, deleteChat, markChatRead,
    subscribePresence, publishPresence,
    getContact, getContacts, resolveLid, getGroupParticipants,
    getChatsOverview, getMessages, getMessage, downloadMedia,
    shutdown,
  };
}
