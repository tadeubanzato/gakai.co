/**
 * An in-memory stand-in for the Baileys provider, used only by the test
 * suite (`GAKAI_PROVIDER_KIND=mock`). It implements the exact same method
 * surface `src/providers/baileys/manager.mjs` does, so `server.mjs` cannot
 * tell the difference — but every method operates on plain in-memory state
 * instead of a live WhatsApp socket, so tests never make a real network
 * connection. A `__test` namespace exposes seeding/inspection helpers no
 * production code ever touches.
 */
import { chatOverview as domainChatOverview } from '../../domain/message.mjs';

export function createMockProvider({ onEvent } = {}) {
  const accounts = new Map(); // id -> {id,status,phone,profile,ownJid}
  const chats = new Map(); // accountId -> Map(chatId -> overview row)
  const messages = new Map(); // accountId -> Map(chatId -> message[] sorted by timestamp asc)
  const contacts = new Map(); // accountId -> Map(contactId -> contact)
  const reactions = new Map(); // accountId -> Map(messageId -> reaction)
  const groupParticipants = new Map(); // accountId -> Map(chatId -> participant[])
  const sent = []; // {accountId, chatId, text, quotedMessageId, mentions}

  const chatsFor = accountId => { if (!chats.has(accountId)) chats.set(accountId, new Map()); return chats.get(accountId); };
  const messagesFor = accountId => { if (!messages.has(accountId)) messages.set(accountId, new Map()); return messages.get(accountId); };
  const contactsFor = accountId => { if (!contacts.has(accountId)) contacts.set(accountId, new Map()); return contacts.get(accountId); };
  const reactionsFor = accountId => { if (!reactions.has(accountId)) reactions.set(accountId, new Map()); return reactions.get(accountId); };
  const groupParticipantsFor = accountId => { if (!groupParticipants.has(accountId)) groupParticipants.set(accountId, new Map()); return groupParticipants.get(accountId); };

  async function startAccount(id, { label } = {}) {
    if (!accounts.has(id)) accounts.set(id, { id, status: 'WORKING', phone: null, profile: label || null, ownJid: `${id}@s.whatsapp.net` });
    return accounts.get(id);
  }
  async function restartAccount(id) { return startAccount(id); }
  async function deleteAccount(id) {
    accounts.delete(id); chats.delete(id); messages.delete(id); contacts.delete(id); reactions.delete(id);
  }
  function listAccounts() { return [...accounts.values()]; }
  function getAccount(id) { return accounts.get(id) || null; }
  async function getQr() { return null; }

  async function sendText(accountId, chatId, text, { quotedMessageId, mentions } = {}) {
    sent.push({ accountId, chatId, text, quotedMessageId: quotedMessageId || null, mentions: Array.isArray(mentions) ? mentions : [] });
    const message = { id: `mock-sent-${sent.length}`, timestamp: Math.floor(Date.now() / 1000), fromMe: true, body: text, text, hasMedia: false, media: null, mediaUrl: null, system: null, replyTo: null, sender: null, mentionedJids: Array.isArray(mentions) ? mentions : [] };
    seedMessage(accountId, chatId, message);
    return message;
  }
  async function sendMedia(accountId, chatId, { buffer, mimetype, filename, caption, kind, ptt } = {}, { quotedMessageId } = {}) {
    const resolvedKind = kind || (String(mimetype || '').startsWith('image/') ? 'image' : String(mimetype || '').startsWith('video/') ? 'video' : String(mimetype || '').startsWith('audio/') ? 'audio' : 'document');
    sent.push({ accountId, chatId, kind: resolvedKind, mimetype: mimetype || null, filename: filename || null, caption: caption || '', ptt: Boolean(ptt), bytes: buffer ? buffer.length : 0, quotedMessageId: quotedMessageId || null });
    const message = { id: `mock-media-${sent.length}`, timestamp: Math.floor(Date.now() / 1000), fromMe: true, body: caption || '', text: caption || '', hasMedia: true, media: { url: null, mimetype: mimetype || null, filename: filename || null }, mediaUrl: null, system: null, replyTo: null, sender: null, mentionedJids: [] };
    seedMessage(accountId, chatId, message);
    return message;
  }
  async function setReaction(accountId, chatId, messageId, reaction) {
    if (reaction) reactionsFor(accountId).set(messageId, reaction);
    else reactionsFor(accountId).delete(messageId);
  }
  async function deleteMessage(accountId, chatId, messageId) {
    const list = messagesFor(accountId).get(chatId);
    if (list) messagesFor(accountId).set(chatId, list.filter(m => m.id !== messageId));
    reactionsFor(accountId).delete(messageId);
  }
  async function deleteChat(accountId, chatId) {
    chatsFor(accountId).delete(chatId);
    messagesFor(accountId).delete(chatId);
  }
  async function markChatRead(accountId, chatId) {
    const chat = chatsFor(accountId).get(chatId);
    if (chat) chat.unreadCount = 0;
  }
  async function subscribePresence() {}
  async function publishPresence() {}

  async function getContact(accountId, contactId, _opts) {
    return contactsFor(accountId).get(contactId) || { id: contactId, phone: null, name: null, picture: null };
  }
  function getContacts(accountId) { return [...contactsFor(accountId).values()]; }
  const whatsappNumbers = new Set(); // digit strings seeded as "on WhatsApp"
  async function checkOnWhatsApp(accountId, phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (digits.length < 6 || digits.length > 15) throw Object.assign(new Error('Enter a valid phone number in international format'), { status: 400 });
    return { exists: whatsappNumbers.has(digits), jid: `${digits}@s.whatsapp.net` };
  }
  async function startConversation(accountId, phone) {
    const { exists, jid } = await checkOnWhatsApp(accountId, phone);
    if (!exists) throw Object.assign(new Error('That number is not on WhatsApp'), { status: 404 });
    const existing = chatsFor(accountId).get(jid);
    if (!existing) chatsFor(accountId).set(jid, { id: jid, name: contactsFor(accountId).get(jid)?.name || null, picture: null, unreadCount: 0, lastMessageTimestamp: Math.floor(Date.now() / 1000), lastMessage: null });
    return domainChatOverview(chatsFor(accountId).get(jid));
  }
  function resolveLid(accountId, lid) { return lid; }
  async function getGroupParticipants(accountId, chatId) { return [...(groupParticipantsFor(accountId).get(chatId) || [])]; }

  // Mirrors the real Baileys manager's contract: getChatsOverview always
  // returns the final, already-normalized Gakai view model, never a raw
  // store row.
  async function getChatsOverview(accountId) { return [...chatsFor(accountId).values()].map(domainChatOverview); }
  async function getMessages(accountId, chatId, { limit = 20, before } = {}) {
    const list = (messagesFor(accountId).get(chatId) || []).slice();
    const filtered = Number.isFinite(before) && before > 0 ? list.filter(m => m.timestamp <= before - 1) : list;
    return filtered.slice(-limit).map(message => withReaction(accountId, message));
  }
  async function getMessage(accountId, chatId, messageId) {
    const list = messagesFor(accountId).get(chatId) || [];
    const message = list.find(m => m.id === messageId);
    return message ? withReaction(accountId, message) : null;
  }
  function withReaction(accountId, message) {
    const reaction = reactionsFor(accountId).get(message.id);
    return reaction ? { ...message, reaction } : message;
  }
  async function downloadMedia() { return null; }
  async function shutdown() {}

  // --- test-only seeding/inspection, never used by server.mjs itself ---
  function seedAccount(id, overrides = {}) {
    accounts.set(id, { id, status: 'WORKING', phone: null, profile: null, ownJid: `${id}@s.whatsapp.net`, ...overrides });
  }
  // chatOverview() (src/domain/message.mjs) reads a chat row's timestamp
  // from `lastMessageTimestamp`, not from `lastMessage.timestamp` — mirror
  // that here so a seeded chat matches the real store's row shape exactly.
  function seedChat(accountId, chat) {
    chatsFor(accountId).set(chat.id, { lastMessageTimestamp: chat.lastMessage?.timestamp || 0, ...chat });
  }
  function seedMessage(accountId, chatId, message) {
    const list = messagesFor(accountId).get(chatId) || [];
    list.push(message);
    list.sort((a, b) => a.timestamp - b.timestamp);
    messagesFor(accountId).set(chatId, list);
    const existing = chatsFor(accountId).get(chatId) || { id: chatId, name: null, picture: null, unreadCount: 0, lastMessageTimestamp: 0 };
    if (message.timestamp >= (existing.lastMessageTimestamp || 0)) {
      chatsFor(accountId).set(chatId, { ...existing, lastMessageTimestamp: message.timestamp, lastMessage: { body: message.body, text: message.text, timestamp: message.timestamp, hasMedia: message.hasMedia, system: message.system || null } });
    }
  }
  function seedContact(accountId, contact) { contactsFor(accountId).set(contact.id, contact); }
  function seedWhatsAppNumber(phone) { whatsappNumbers.add(String(phone || '').replace(/[^0-9]/g, '')); }
  function seedGroupParticipants(accountId, chatId, participants) { groupParticipantsFor(accountId).set(chatId, participants); }
  // Simulates a live inbound WhatsApp message the same way a real
  // messages.upsert('notify') event would — stores it and, unless it's a
  // fromMe echo, fires the same onEvent('message', ...) callback server.mjs
  // wires to dispatchAutomationEvent. Replaces the old
  // "POST /api/app/provider-events with an HMAC signature" test mechanism,
  // which no longer exists now that ingestion is in-process.
  function simulateIncomingMessage(accountId, chatId, message) {
    const full = { id: message.id, timestamp: message.timestamp ?? Math.floor(Date.now() / 1000), fromMe: false, body: message.body ?? '', text: message.text ?? message.body ?? '', hasMedia: Boolean(message.hasMedia), media: message.media || null, mediaUrl: message.mediaUrl || null, system: message.system || null, replyTo: message.replyTo || null, sender: message.sender || null, mentionedJids: message.mentionedJids || [] };
    seedMessage(accountId, chatId, full);
    if (onEvent) onEvent('message', { accountId, chatId, message: full, raw: full });
  }
  function getSentMessages() { return sent; }
  function getReaction(accountId, messageId) { return reactionsFor(accountId).get(messageId) || null; }

  return {
    startAccount, restartAccount, deleteAccount, listAccounts, getAccount, getQr,
    sendText, sendMedia, setReaction, deleteMessage, deleteChat, markChatRead,
    subscribePresence, publishPresence,
    getContact, getContacts, resolveLid, getGroupParticipants,
    checkOnWhatsApp, startConversation,
    getChatsOverview, getMessages, getMessage, downloadMedia,
    shutdown,
    __test: { seedAccount, seedChat, seedMessage, seedContact, seedWhatsAppNumber, seedGroupParticipants, simulateIncomingMessage, getSentMessages, getReaction },
  };
}
