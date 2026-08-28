/**
 * Gakai's own local chat/message/contact store.
 *
 * Baileys is purely event-driven over WebSocket — it has no REST-style query
 * API for chat/message history the way the old provider did, and its own
 * maintainers explicitly recommend against relying on its optional in-memory
 * store for anything beyond a toy. So this module owns exactly what the old
 * REST proxying used to answer on the provider's behalf: chat overviews,
 * paginated message history, and contact lookups, all served from Gakai's
 * own SQLite database, populated by the adapter as Baileys events arrive.
 *
 * Reuses the same `gakai.db` DatabaseSync connection server.mjs already
 * opens for `app_state`/`app_events`, rather than a second connection to the
 * same file.
 */

export function openStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_chats (
      account_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_message_timestamp INTEGER NOT NULL DEFAULT 0,
      last_message_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, chat_id)
    );
    CREATE INDEX IF NOT EXISTS wa_chats_account_ts ON wa_chats(account_id, last_message_timestamp);

    CREATE TABLE IF NOT EXISTS wa_messages (
      account_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      from_me INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS wa_messages_lookup ON wa_messages(account_id, chat_id, timestamp);

    CREATE TABLE IF NOT EXISTS wa_contacts (
      account_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      phone TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS wa_lid_map (
      account_id TEXT NOT NULL,
      lid TEXT NOT NULL,
      phone_jid TEXT NOT NULL,
      PRIMARY KEY (account_id, lid)
    );

    CREATE TABLE IF NOT EXISTS wa_reactions (
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      reaction TEXT NOT NULL,
      reacted_at TEXT NOT NULL,
      PRIMARY KEY (account_id, message_id, sender_id)
    );
  `);

  const stmt = {
    upsertChat: db.prepare(`
      INSERT INTO wa_chats(account_id, chat_id, name, picture, unread_count, last_message_timestamp, last_message_json, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id, chat_id) DO UPDATE SET
        name=COALESCE(excluded.name, wa_chats.name),
        picture=COALESCE(excluded.picture, wa_chats.picture),
        unread_count=excluded.unread_count,
        updated_at=excluded.updated_at
    `),
    bumpChatLastMessage: db.prepare(`
      UPDATE wa_chats SET last_message_timestamp=?, last_message_json=?, updated_at=?
      WHERE account_id=? AND chat_id=? AND last_message_timestamp<=?
    `),
    ensureChat: db.prepare(`
      INSERT INTO wa_chats(account_id, chat_id, name, picture, unread_count, last_message_timestamp, last_message_json, updated_at)
      VALUES (?,?,NULL,NULL,0,0,NULL,?)
      ON CONFLICT(account_id, chat_id) DO NOTHING
    `),
    getChat: db.prepare(`SELECT * FROM wa_chats WHERE account_id=? AND chat_id=?`),
    listChats: db.prepare(`SELECT * FROM wa_chats WHERE account_id=? ORDER BY last_message_timestamp DESC LIMIT ?`),
    deleteChat: db.prepare(`DELETE FROM wa_chats WHERE account_id=? AND chat_id=?`),
    deleteChatMessages: db.prepare(`DELETE FROM wa_messages WHERE account_id=? AND chat_id=?`),
    setUnread: db.prepare(`UPDATE wa_chats SET unread_count=? WHERE account_id=? AND chat_id=?`),

    upsertMessage: db.prepare(`
      INSERT INTO wa_messages(account_id, chat_id, message_id, timestamp, from_me, payload_json, created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id, chat_id, message_id) DO UPDATE SET
        timestamp=excluded.timestamp, from_me=excluded.from_me, payload_json=excluded.payload_json
    `),
    getMessage: db.prepare(`SELECT * FROM wa_messages WHERE account_id=? AND chat_id=? AND message_id=?`),
    deleteMessage: db.prepare(`DELETE FROM wa_messages WHERE account_id=? AND chat_id=? AND message_id=?`),
    listMessagesPage: db.prepare(`
      SELECT * FROM wa_messages WHERE account_id=? AND chat_id=? AND timestamp<=?
      ORDER BY timestamp DESC LIMIT ?
    `),
    listMessagesLatest: db.prepare(`
      SELECT * FROM wa_messages WHERE account_id=? AND chat_id=?
      ORDER BY timestamp DESC LIMIT ?
    `),
    findMessageById: db.prepare(`SELECT * FROM wa_messages WHERE account_id=? AND message_id=? LIMIT 1`),

    upsertContact: db.prepare(`
      INSERT INTO wa_contacts(account_id, contact_id, name, picture, phone, updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_id, contact_id) DO UPDATE SET
        name=COALESCE(excluded.name, wa_contacts.name),
        picture=COALESCE(excluded.picture, wa_contacts.picture),
        phone=COALESCE(excluded.phone, wa_contacts.phone),
        updated_at=excluded.updated_at
    `),
    getContact: db.prepare(`SELECT * FROM wa_contacts WHERE account_id=? AND contact_id=?`),
    listContacts: db.prepare(`SELECT * FROM wa_contacts WHERE account_id=?`),

    setLid: db.prepare(`INSERT INTO wa_lid_map(account_id, lid, phone_jid) VALUES (?,?,?) ON CONFLICT(account_id, lid) DO UPDATE SET phone_jid=excluded.phone_jid`),
    getLid: db.prepare(`SELECT phone_jid FROM wa_lid_map WHERE account_id=? AND lid=?`),

    upsertReaction: db.prepare(`
      INSERT INTO wa_reactions(account_id, message_id, sender_id, reaction, reacted_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(account_id, message_id, sender_id) DO UPDATE SET reaction=excluded.reaction, reacted_at=excluded.reacted_at
    `),
    // rowid as a tiebreaker: two reactions arriving within the same
    // millisecond would otherwise sort ambiguously by reacted_at alone.
    latestReaction: db.prepare(`SELECT reaction, sender_id, reacted_at FROM wa_reactions WHERE account_id=? AND message_id=? ORDER BY reacted_at DESC, rowid DESC LIMIT 1`),
    ownReaction: db.prepare(`SELECT reaction FROM wa_reactions WHERE account_id=? AND message_id=? AND sender_id=?`),
    deleteReactionsForMessage: db.prepare(`DELETE FROM wa_reactions WHERE account_id=? AND message_id=?`),

    deleteAccountChats: db.prepare(`DELETE FROM wa_chats WHERE account_id=?`),
    deleteAccountMessages: db.prepare(`DELETE FROM wa_messages WHERE account_id=?`),
    deleteAccountContacts: db.prepare(`DELETE FROM wa_contacts WHERE account_id=?`),
    deleteAccountLids: db.prepare(`DELETE FROM wa_lid_map WHERE account_id=?`),
    deleteAccountReactions: db.prepare(`DELETE FROM wa_reactions WHERE account_id=?`),
  };

  const now = () => new Date().toISOString();

  function upsertChats(accountId, chats) {
    for (const chat of chats) {
      if (!chat?.id) continue;
      stmt.upsertChat.run(
        accountId, chat.id,
        chat.name ?? null,
        chat.picture ?? null,
        Number(chat.unreadCount || 0) || 0,
        Number(chat.conversationTimestamp) || 0,
        null,
        now(),
      );
    }
  }

  function setChatUnread(accountId, chatId, unreadCount) {
    stmt.ensureChat.run(accountId, chatId, now());
    stmt.setUnread.run(Math.max(0, Number(unreadCount) || 0), accountId, chatId);
  }

  function setChatPicture(accountId, chatId, pictureUrl) {
    stmt.ensureChat.run(accountId, chatId, now());
    db.prepare(`UPDATE wa_chats SET picture=? WHERE account_id=? AND chat_id=?`).run(pictureUrl, accountId, chatId);
  }

  // Stores every message (needed for history/pagination) and — only if this
  // message is at least as new as what's already cached — refreshes the
  // chat's denormalized last-message snapshot, so chat-overview reads never
  // need to join against the messages table.
  function upsertMessages(accountId, rows) {
    for (const row of rows) {
      const { chatId, messageId, timestamp, fromMe, waMessage, overviewMessage } = row;
      if (!chatId || !messageId) continue;
      stmt.ensureChat.run(accountId, chatId, now());
      stmt.upsertMessage.run(accountId, chatId, messageId, timestamp, fromMe ? 1 : 0, JSON.stringify(waMessage), now());
      stmt.bumpChatLastMessage.run(timestamp, JSON.stringify(overviewMessage), now(), accountId, chatId, timestamp);
    }
  }

  function deleteMessage(accountId, chatId, messageId) {
    stmt.deleteMessage.run(accountId, chatId, messageId);
    stmt.deleteReactionsForMessage.run(accountId, messageId);
  }

  // Rewrite a stored message's text in place (an inbound or outbound edit) and
  // mark it edited, mirroring how deleteMessage handles a REVOKE.
  function applyEdit(accountId, chatId, targetMessageId, newText) {
    const row = (chatId && stmt.getMessage.get(accountId, chatId, targetMessageId)) || stmt.findMessageById.get(accountId, targetMessageId);
    if (!row) return false;
    const raw = JSON.parse(row.payload_json);
    const message = raw.message || {};
    if (typeof message.conversation === 'string') message.conversation = newText;
    else if (message.extendedTextMessage) message.extendedTextMessage.text = newText;
    else message.conversation = newText;
    raw.message = message;
    raw.edited = true;
    stmt.upsertMessage.run(accountId, row.chat_id, targetMessageId, row.timestamp, row.from_me, JSON.stringify(raw), now());
    stmt.bumpChatLastMessage.run(row.timestamp, JSON.stringify({ body: newText, text: newText, timestamp: row.timestamp, hasMedia: false, system: null }), now(), accountId, row.chat_id, row.timestamp);
    return true;
  }

  function deleteChat(accountId, chatId) {
    stmt.deleteChatMessages.run(accountId, chatId);
    stmt.deleteChat.run(accountId, chatId);
  }

  function listChatIds(accountId) {
    return db.prepare(`SELECT chat_id FROM wa_chats WHERE account_id=?`).all(accountId).map(row => row.chat_id);
  }

  function chatExists(accountId, chatId) {
    return Boolean(stmt.getChat.get(accountId, chatId));
  }

  // Create an empty chat row if it doesn't exist yet (opening a brand-new
  // conversation before any message has been exchanged). No-op if present.
  function ensureChat(accountId, chatId) {
    if (!accountId || !chatId) return;
    stmt.ensureChat.run(accountId, chatId, now());
  }

  // Fold one chat's history into another and drop the source row. Used to
  // reunite a conversation that WhatsApp split across a contact's phone-number
  // JID and its LID (privacy) identifier: `from` (the LID chat) is merged into
  // `to` (the canonical phone-JID chat). Idempotent — a re-run with nothing to
  // move is a no-op.
  function mergeChat(accountId, fromChatId, toChatId) {
    if (!fromChatId || !toChatId || fromChatId === toChatId) return;
    stmt.ensureChat.run(accountId, toChatId, now());
    db.prepare(`
      INSERT INTO wa_messages(account_id, chat_id, message_id, timestamp, from_me, payload_json, created_at)
      SELECT account_id, ?, message_id, timestamp, from_me, payload_json, created_at
      FROM wa_messages WHERE account_id=? AND chat_id=?
      ON CONFLICT(account_id, chat_id, message_id) DO NOTHING
    `).run(toChatId, accountId, fromChatId);
    const from = stmt.getChat.get(accountId, fromChatId);
    const to = stmt.getChat.get(accountId, toChatId);
    if (from) {
      db.prepare(`
        UPDATE wa_chats SET
          name=COALESCE(name, ?),
          picture=COALESCE(picture, ?),
          unread_count=MAX(unread_count, ?)
        WHERE account_id=? AND chat_id=?
      `).run(from.name ?? null, from.picture ?? null, from.unread_count ?? 0, accountId, toChatId);
      if ((from.last_message_timestamp || 0) > (to?.last_message_timestamp || 0)) {
        db.prepare(`UPDATE wa_chats SET last_message_timestamp=?, last_message_json=? WHERE account_id=? AND chat_id=?`)
          .run(from.last_message_timestamp, from.last_message_json, accountId, toChatId);
      }
    }
    stmt.deleteChatMessages.run(accountId, fromChatId);
    stmt.deleteChat.run(accountId, fromChatId);
  }

  function getChatsOverview(accountId, limit = 200) {
    return stmt.listChats.all(accountId, limit).map(row => ({
      id: row.chat_id,
      name: row.name,
      picture: row.picture,
      unreadCount: row.unread_count,
      lastMessageTimestamp: row.last_message_timestamp,
      lastMessage: row.last_message_json ? JSON.parse(row.last_message_json) : null,
    }));
  }

  function getMessagesPage(accountId, chatId, { limit = 20, before } = {}) {
    const rows = Number.isFinite(before) && before > 0
      ? stmt.listMessagesPage.all(accountId, chatId, before - 1, limit)
      : stmt.listMessagesLatest.all(accountId, chatId, limit);
    return rows.map(row => JSON.parse(row.payload_json));
  }

  function getMessageById(accountId, chatId, messageId) {
    const row = chatId ? stmt.getMessage.get(accountId, chatId, messageId) : stmt.findMessageById.get(accountId, messageId);
    return row ? JSON.parse(row.payload_json) : null;
  }

  function upsertContacts(accountId, contacts) {
    for (const contact of contacts) {
      if (!contact?.id) continue;
      stmt.upsertContact.run(
        accountId, contact.id,
        contact.name ?? contact.notify ?? contact.verifiedName ?? null,
        contact.picture ?? null,
        contact.phone ?? null,
        now(),
      );
    }
  }

  function setContactPicture(accountId, contactId, pictureUrl) {
    stmt.upsertContact.run(accountId, contactId, null, pictureUrl, null, now());
  }

  function getContact(accountId, contactId) {
    return stmt.getContact.get(accountId, contactId) || null;
  }

  function getContacts(accountId) {
    return stmt.listContacts.all(accountId);
  }

  function setLidMapping(accountId, lid, phoneJid) {
    stmt.setLid.run(accountId, lid, phoneJid);
  }

  function resolveLid(accountId, lid) {
    return stmt.getLid.get(accountId, lid)?.phone_jid || null;
  }

  // Applies an inbound reaction event. Reactions are per-sender on
  // WhatsApp's own protocol (each participant in a group can react
  // independently) — Gakai's UI shows a single badge per message, so the
  // most recently received reaction (from any participant, own account
  // included) is what's surfaced. An empty `reaction` string clears that
  // sender's reaction, matching WhatsApp's own "tap the same emoji again to
  // remove it" behavior.
  function applyReaction(accountId, { targetMessageId, senderId, reaction }) {
    if (!targetMessageId || !senderId) return;
    if (reaction) stmt.upsertReaction.run(accountId, targetMessageId, senderId, reaction, now());
    else db.prepare(`DELETE FROM wa_reactions WHERE account_id=? AND message_id=? AND sender_id=?`).run(accountId, targetMessageId, senderId);
  }

  function getReaction(accountId, messageId) {
    return stmt.latestReaction.get(accountId, messageId)?.reaction || null;
  }

  function deleteAccountData(accountId) {
    stmt.deleteAccountChats.run(accountId);
    stmt.deleteAccountMessages.run(accountId);
    stmt.deleteAccountContacts.run(accountId);
    stmt.deleteAccountLids.run(accountId);
    stmt.deleteAccountReactions.run(accountId);
  }

  return {
    upsertChats, setChatUnread, setChatPicture, deleteChat, getChatsOverview,
    listChatIds, chatExists, ensureChat, mergeChat,
    upsertMessages, deleteMessage, applyEdit, getMessagesPage, getMessageById,
    upsertContacts, setContactPicture, getContact, getContacts,
    setLidMapping, resolveLid,
    applyReaction, getReaction,
    deleteAccountData,
  };
}
