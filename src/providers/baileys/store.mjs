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

import { startsUnread } from '../../domain/unread.mjs';
import { isDisplayableConversation, DISPLAYABLE_JID_SQL } from '../../domain/jid.mjs';
import { encodeCursor, decodeCursor, clampPageSize } from '../../domain/conversation-list.mjs';

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
    CREATE INDEX IF NOT EXISTS wa_chats_page ON wa_chats(account_id, last_message_timestamp DESC, chat_id DESC);

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

    CREATE TABLE IF NOT EXISTS wa_starred (
      account_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      starred_at TEXT NOT NULL,
      PRIMARY KEY (account_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS wa_blocklist (
      account_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      PRIMARY KEY (account_id, jid)
    );
  `);

  // Lightweight column migration for wa_chats — the schema above only runs for a
  // fresh database, so per-chat state added later needs an explicit ALTER.
  const chatColumns = new Set(db.prepare(`PRAGMA table_info(wa_chats)`).all().map(column => column.name));
  for (const [name, ddl] of [
    ['pinned', 'INTEGER NOT NULL DEFAULT 0'],
    ['muted_until', 'INTEGER NOT NULL DEFAULT 0'],
    ['archived', 'INTEGER NOT NULL DEFAULT 0'],
    ['ephemeral', 'INTEGER NOT NULL DEFAULT 0'],
  ]) if (!chatColumns.has(name)) db.exec(`ALTER TABLE wa_chats ADD COLUMN ${name} ${ddl}`);

  // A contact's names are kept apart so the display-name hierarchy (domain/identity.mjs) can rank
  // them: `name` is the contact-sync name, then a verified business name, then the person's own
  // push name. Rows written before this split keep whatever they had in `name`.
  const contactColumns = new Set(db.prepare(`PRAGMA table_info(wa_contacts)`).all().map(column => column.name));
  for (const name of ['push_name', 'verified_name']) if (!contactColumns.has(name)) db.exec(`ALTER TABLE wa_contacts ADD COLUMN ${name} TEXT`);

  // Read state. A conversation has a monotonic read cursor (`read_ts`: everything at or before it is
  // read) and each stored message carries an `unread` flag; the number shown is COUNTED from those
  // flags. The old `unread_count` column is no longer written or read.
  if (!chatColumns.has('read_ts')) {
    db.exec(`ALTER TABLE wa_chats ADD COLUMN read_ts INTEGER NOT NULL DEFAULT 0`);
    const messageColumns = new Set(db.prepare(`PRAGMA table_info(wa_messages)`).all().map(column => column.name));
    if (!messageColumns.has('unread')) db.exec(`ALTER TABLE wa_messages ADD COLUMN unread INTEGER NOT NULL DEFAULT 0`);
    backfillReadState(db);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_messages_unread ON wa_messages(account_id, chat_id) WHERE unread=1`);

  const stmt = {
    upsertChat: db.prepare(`
      INSERT INTO wa_chats(account_id, chat_id, name, picture, unread_count, last_message_timestamp, last_message_json, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id, chat_id) DO UPDATE SET
        name=COALESCE(excluded.name, wa_chats.name),
        picture=COALESCE(excluded.picture, wa_chats.picture),
        updated_at=excluded.updated_at
    `),
    bumpChatLastMessage: db.prepare(`
      UPDATE wa_chats SET last_message_timestamp=?, last_message_json=?, updated_at=?
      WHERE account_id=? AND chat_id=? AND (last_message_timestamp<=? OR last_message_json IS NULL)
    `),
    ensureChat: db.prepare(`
      INSERT INTO wa_chats(account_id, chat_id, name, picture, unread_count, last_message_timestamp, last_message_json, updated_at)
      VALUES (?,?,NULL,NULL,0,0,NULL,?)
      ON CONFLICT(account_id, chat_id) DO NOTHING
    `),
    getChat: db.prepare(`SELECT * FROM wa_chats WHERE account_id=? AND chat_id=?`),
    listChats: db.prepare(`SELECT * FROM wa_chats WHERE account_id=? AND ${DISPLAYABLE_JID_SQL} ORDER BY last_message_timestamp DESC, chat_id DESC LIMIT ?`),
    deleteChat: db.prepare(`DELETE FROM wa_chats WHERE account_id=? AND chat_id=?`),
    deleteChatMessages: db.prepare(`DELETE FROM wa_messages WHERE account_id=? AND chat_id=?`),
    getMessageRow: db.prepare(`SELECT unread FROM wa_messages WHERE account_id=? AND chat_id=? AND message_id=?`),
    countUnread: db.prepare(`SELECT COUNT(*) AS n FROM wa_messages WHERE account_id=? AND chat_id=? AND unread=1`),
    newestTimestamp: db.prepare(`SELECT MAX(timestamp) AS ts FROM wa_messages WHERE account_id=? AND chat_id=?`),
    advanceCursor: db.prepare(`UPDATE wa_chats SET read_ts=MAX(read_ts, ?) WHERE account_id=? AND chat_id=?`),
    clearUnreadThrough: db.prepare(`UPDATE wa_messages SET unread=0 WHERE account_id=? AND chat_id=? AND unread=1 AND timestamp<=?`),

    upsertMessage: db.prepare(`
      INSERT INTO wa_messages(account_id, chat_id, message_id, timestamp, from_me, payload_json, created_at, unread)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id, chat_id, message_id) DO UPDATE SET
        timestamp=excluded.timestamp, from_me=excluded.from_me, payload_json=excluded.payload_json
    `),
    getMessage: db.prepare(`SELECT * FROM wa_messages WHERE account_id=? AND chat_id=? AND message_id=?`),
    deleteMessage: db.prepare(`DELETE FROM wa_messages WHERE account_id=? AND chat_id=? AND message_id=?`),
    setChatPreview: db.prepare(`UPDATE wa_chats SET last_message_timestamp=?, last_message_json=?, updated_at=? WHERE account_id=? AND chat_id=?`),
    clearChatPreview: db.prepare(`UPDATE wa_chats SET last_message_json=NULL, updated_at=? WHERE account_id=? AND chat_id=?`),
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
      INSERT INTO wa_contacts(account_id, contact_id, name, picture, phone, updated_at, push_name, verified_name)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id, contact_id) DO UPDATE SET
        name=COALESCE(excluded.name, wa_contacts.name),
        picture=COALESCE(excluded.picture, wa_contacts.picture),
        phone=COALESCE(excluded.phone, wa_contacts.phone),
        push_name=COALESCE(excluded.push_name, wa_contacts.push_name),
        verified_name=COALESCE(excluded.verified_name, wa_contacts.verified_name),
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

  // Status, broadcast lists, channels and bots are never conversations here (see
  // domain/jid.mjs); nothing is stored under their ids, so they cannot pick up unread counts either.
  const ensureRow = (accountId, chatId) => { if (isDisplayableConversation(chatId)) stmt.ensureChat.run(accountId, chatId, now()); };

  // Partial update of the per-chat state columns (pinned / muted_until /
  // archived / ephemeral). Only the keys present in `flags` are written.
  function setChatFlags(accountId, chatId, flags = {}) {
    ensureRow(accountId, chatId);
    const map = { pinned: 'pinned', mutedUntil: 'muted_until', archived: 'archived', ephemeral: 'ephemeral' };
    const sets = [], values = [];
    for (const [key, column] of Object.entries(map)) {
      if (flags[key] === undefined) continue;
      sets.push(`${column}=?`);
      values.push(typeof flags[key] === 'boolean' ? (flags[key] ? 1 : 0) : Number(flags[key]) || 0);
    }
    if (!sets.length) return;
    db.prepare(`UPDATE wa_chats SET ${sets.join(', ')} WHERE account_id=? AND chat_id=?`).run(...values, accountId, chatId);
  }

  // Map Baileys' own pin/mute/archive fields off a chats.update row. They arrive
  // inconsistently named across event shapes, so accept every spelling seen.
  function chatFlagsFromEvent(chat) {
    const flags = {};
    if ('pin' in chat || 'pinned' in chat) flags.pinned = Boolean(chat.pin || chat.pinned);
    const mute = chat.muteEndTime ?? chat.mute;
    if (mute !== undefined && mute !== null) flags.mutedUntil = Math.floor(Number(mute) > 1e12 ? Number(mute) / 1000 : Number(mute)) || 0;
    if ('archived' in chat || 'archive' in chat) flags.archived = Boolean(chat.archived ?? chat.archive);
    if (chat.ephemeralExpiration !== undefined) flags.ephemeral = Number(chat.ephemeralExpiration) || 0;
    return flags;
  }

  function upsertChats(accountId, chats) {
    for (const chat of chats) {
      if (!chat?.id || !isDisplayableConversation(chat.id)) continue;
      stmt.upsertChat.run(
        accountId, chat.id,
        chat.name ?? null,
        chat.picture ?? null,
        0,
        Number(chat.conversationTimestamp) || 0,
        null,
        now(),
      );
      const flags = chatFlagsFromEvent(chat);
      if (Object.keys(flags).length) setChatFlags(accountId, chat.id, flags);
    }
  }

  // Blocklist: a set of jids this account has blocked, kept in sync from
  // Baileys' blocklist.set (full) / blocklist.update (delta) events.
  function replaceBlocklist(accountId, jids) {
    db.prepare(`DELETE FROM wa_blocklist WHERE account_id=?`).run(accountId);
    const insert = db.prepare(`INSERT INTO wa_blocklist(account_id, jid) VALUES (?,?) ON CONFLICT DO NOTHING`);
    for (const jid of jids || []) if (jid) insert.run(accountId, jid);
  }
  function setBlocked(accountId, jid, blocked) {
    if (blocked) db.prepare(`INSERT INTO wa_blocklist(account_id, jid) VALUES (?,?) ON CONFLICT DO NOTHING`).run(accountId, jid);
    else db.prepare(`DELETE FROM wa_blocklist WHERE account_id=? AND jid=?`).run(accountId, jid);
  }
  function isBlocked(accountId, jid) {
    return Boolean(db.prepare(`SELECT 1 FROM wa_blocklist WHERE account_id=? AND jid=?`).get(accountId, jid));
  }
  function blockedJids(accountId) {
    return new Set(db.prepare(`SELECT jid FROM wa_blocklist WHERE account_id=?`).all(accountId).map(row => row.jid));
  }

  // Read state. The cursor only ever moves forward, so a late or repeated "read" can never
  // un-read anything, and a message is judged unread once, when it is first stored.
  function unreadCountOf(accountId, chatId) {
    return stmt.countUnread.get(accountId, chatId).n;
  }

  // Mark everything at or before `through` (unix seconds; default: the newest message) as read.
  // Returns the conversation's new unread count.
  function markChatRead(accountId, chatId, through) {
    const row = stmt.getChat.get(accountId, chatId);
    if (!row) return 0;
    const boundary = Number.isFinite(Number(through)) && Number(through) > 0
      ? Math.floor(Number(through))
      : (stmt.newestTimestamp.get(accountId, chatId).ts || 0);
    db.exec('BEGIN');
    try {
      stmt.advanceCursor.run(boundary, accountId, chatId);
      stmt.clearUnreadThrough.run(accountId, chatId, boundary);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return unreadCountOf(accountId, chatId);
  }

  // Another of the owner's devices read these incoming messages: that reads them here too, along
  // with everything before the newest of them. Returns the new count, or null if nothing matched.
  function markMessagesReadElsewhere(accountId, chatId, messageIds) {
    let newest = 0;
    for (const id of messageIds) {
      const found = db.prepare(`SELECT timestamp FROM wa_messages WHERE account_id=? AND chat_id=? AND message_id=? AND from_me=0`).get(accountId, chatId, id);
      if (found) newest = Math.max(newest, found.timestamp || 0);
    }
    return newest ? markChatRead(accountId, chatId, newest) : null;
  }

  // WhatsApp keys of the still-unread incoming messages up to `through`, for read receipts.
  function unreadIncomingKeys(accountId, chatId, through) {
    const boundary = Number.isFinite(Number(through)) && Number(through) > 0 ? Math.floor(Number(through)) : Number.MAX_SAFE_INTEGER;
    return db.prepare(`SELECT payload_json FROM wa_messages WHERE account_id=? AND chat_id=? AND unread=1 AND from_me=0 AND timestamp<=? ORDER BY timestamp DESC LIMIT 100`)
      .all(accountId, chatId, boundary)
      .map(row => { try { return JSON.parse(row.payload_json).key; } catch { return null; } })
      .filter(key => key?.id && key.remoteJid);
  }

  function hasUnread(accountId) {
    return Boolean(db.prepare(`SELECT 1 FROM wa_messages WHERE account_id=? AND unread=1 AND ${DISPLAYABLE_JID_SQL} LIMIT 1`).get(accountId));
  }

  function setChatPicture(accountId, chatId, pictureUrl) {
    ensureRow(accountId, chatId);
    db.prepare(`UPDATE wa_chats SET picture=? WHERE account_id=? AND chat_id=?`).run(pictureUrl, accountId, chatId);
  }

  // Stores every message (needed for history/pagination) and — only if this
  // message is at least as new as what's already cached — refreshes the
  // chat's denormalized last-message snapshot, so chat-overview reads never
  // need to join against the messages table.
  function upsertMessages(accountId, rows) {
    for (const row of rows) {
      const { chatId, messageId, timestamp, fromMe, waMessage, overviewMessage } = row;
      if (!chatId || !messageId || !isDisplayableConversation(chatId)) continue;
      ensureRow(accountId, chatId);
      // Only a message seen for the first time can start unread; a replay keeps its verdict.
      const seen = stmt.getMessageRow.get(accountId, chatId, messageId);
      const unread = !seen && startsUnread({
        source: row.source,
        message: { ...overviewMessage, fromMe, timestamp },
        readCursor: stmt.getChat.get(accountId, chatId)?.read_ts || 0,
      }) ? 1 : 0;
      stmt.upsertMessage.run(accountId, chatId, messageId, timestamp, fromMe ? 1 : 0, JSON.stringify(waMessage), now(), unread);
      stmt.bumpChatLastMessage.run(timestamp, JSON.stringify(overviewMessage), now(), accountId, chatId, timestamp);
    }
  }

  function deleteMessage(accountId, chatId, messageId) {
    stmt.deleteMessage.run(accountId, chatId, messageId);
    stmt.deleteReactionsForMessage.run(accountId, messageId);
    db.prepare(`DELETE FROM wa_starred WHERE account_id=? AND message_id=?`).run(accountId, messageId);
  }

  // Deleting a message must not leave its text behind as the chat's preview line
  // in the inbox: point the preview at whatever is now the newest message
  // (`overviewOf` turns a stored raw message into the preview shape). With
  // nothing left to show, the preview is emptied and the chat drops out of the
  // inbox list until its next message arrives.
  function deleteMessageAndRefreshPreview(accountId, chatId, messageId, overviewOf) {
    deleteMessage(accountId, chatId, messageId);
    const [latest] = getMessagesPage(accountId, chatId, { limit: 1 });
    if (!latest) { stmt.clearChatPreview.run(now(), accountId, chatId); return; }
    const preview = overviewOf(latest);
    stmt.setChatPreview.run(preview.timestamp || 0, JSON.stringify(preview), now(), accountId, chatId);
  }

  // WhatsApp's "clear chat": every message goes, the conversation itself stays.
  function clearChatMessages(accountId, chatId) {
    stmt.deleteChatMessages.run(accountId, chatId);
    stmt.clearChatPreview.run(now(), accountId, chatId);
  }

  function setStarred(accountId, chatId, messageId, on) {
    if (on) db.prepare(`INSERT INTO wa_starred(account_id, chat_id, message_id, starred_at) VALUES (?,?,?,?) ON CONFLICT(account_id, message_id) DO NOTHING`).run(accountId, chatId, messageId, now());
    else db.prepare(`DELETE FROM wa_starred WHERE account_id=? AND message_id=?`).run(accountId, messageId);
  }
  function isStarred(accountId, messageId) {
    return Boolean(db.prepare(`SELECT 1 FROM wa_starred WHERE account_id=? AND message_id=?`).get(accountId, messageId));
  }
  function starredMessageIds(accountId) {
    return new Set(db.prepare(`SELECT message_id FROM wa_starred WHERE account_id=?`).all(accountId).map(row => row.message_id));
  }
  // Starred messages across every chat, newest first, with their stored payload.
  function listStarred(accountId, limit = 100) {
    return db.prepare(`
      SELECT s.chat_id, m.payload_json
      FROM wa_starred s JOIN wa_messages m
        ON m.account_id = s.account_id AND m.message_id = s.message_id
      WHERE s.account_id=?
      ORDER BY m.timestamp DESC LIMIT ?
    `).all(accountId, limit).map(row => ({ chatId: row.chat_id, waMessage: JSON.parse(row.payload_json) }));
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
    db.prepare(`DELETE FROM wa_starred WHERE account_id=? AND chat_id=?`).run(accountId, chatId);
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
    ensureRow(accountId, chatId);
  }

  // Fold one chat's history into another and drop the source row. Used to
  // reunite a conversation that WhatsApp split across a contact's phone-number
  // JID and its LID (privacy) identifier: `from` (the LID chat) is merged into
  // `to` (the canonical phone-JID chat). Idempotent — a re-run with nothing to
  // move is a no-op.
  function mergeChat(accountId, fromChatId, toChatId) {
    if (!fromChatId || !toChatId || fromChatId === toChatId) return;
    ensureRow(accountId, toChatId);
    db.prepare(`
      INSERT INTO wa_messages(account_id, chat_id, message_id, timestamp, from_me, payload_json, created_at, unread)
      SELECT account_id, ?, message_id, timestamp, from_me, payload_json, created_at, unread
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
          read_ts=MAX(read_ts, ?)
        WHERE account_id=? AND chat_id=?
      `).run(from.name ?? null, from.picture ?? null, from.read_ts ?? 0, accountId, toChatId);
      if ((from.last_message_timestamp || 0) > (to?.last_message_timestamp || 0)) {
        db.prepare(`UPDATE wa_chats SET last_message_timestamp=?, last_message_json=? WHERE account_id=? AND chat_id=?`)
          .run(from.last_message_timestamp, from.last_message_json, accountId, toChatId);
      }
    }
    stmt.deleteChatMessages.run(accountId, fromChatId);
    stmt.deleteChat.run(accountId, fromChatId);
  }

  const overviewOf = row => ({
    id: row.chat_id,
    name: row.name,
    picture: row.picture,
    unreadCount: unreadCountOf(row.account_id, row.chat_id),
    lastMessageTimestamp: row.last_message_timestamp,
    lastMessage: row.last_message_json ? JSON.parse(row.last_message_json) : null,
    pinned: Boolean(row.pinned),
    mutedUntil: row.muted_until || 0,
    archived: Boolean(row.archived),
    ephemeral: row.ephemeral || 0,
  });

  function getChatOverview(accountId, chatId) {
    const row = stmt.getChat.get(accountId, chatId);
    return row ? overviewOf(row) : null;
  }

  function getChatsOverview(accountId, limit = 200) {
    return stmt.listChats.all(accountId, limit).map(overviewOf);
  }

  // A chat is worth listing only if a real message (or call) is behind its timestamp — metadata
  // churn and handshake notices also touch a chat. Mirrors hasMessageContent() in domain/message.mjs.
  const HAS_CONTENT_SQL = `last_message_json IS NOT NULL AND (
    COALESCE(json_extract(last_message_json,'$.body'),'')<>'' OR COALESCE(json_extract(last_message_json,'$.text'),'')<>''
    OR json_extract(last_message_json,'$.hasMedia')=1 OR json_extract(last_message_json,'$.system.kind')='call')`;

  // One page of the conversation list: newest activity first, ties broken by id, resuming after
  // `cursor`. Filtering happens in SQL so `limit` rows really are `limit` listable conversations,
  // and only one page ever leaves the database, however many chats are stored.
  function listChatsPage(accountId, { limit, cursor, archived = false } = {}) {
    const size = clampPageSize(limit);
    const after = decodeCursor(cursor);
    const rows = db.prepare(`
      SELECT * FROM wa_chats
      WHERE account_id=? AND archived=? AND ${DISPLAYABLE_JID_SQL} AND ${HAS_CONTENT_SQL}
        ${after ? 'AND (last_message_timestamp<? OR (last_message_timestamp=? AND chat_id<?))' : ''}
      ORDER BY last_message_timestamp DESC, chat_id DESC LIMIT ?
    `).all(accountId, archived ? 1 : 0, ...(after ? [after.timestamp, after.timestamp, after.id] : []), size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return { chats: page.map(overviewOf), nextCursor: rows.length > size ? encodeCursor(last.last_message_timestamp, last.chat_id) : null };
  }

  // Contact rows that can name each of `chatIds`: the id's own row, then the row of its LID or
  // phone-number alias. Three batched queries for the whole page, never one per conversation.
  function getContactsForChats(accountId, chatIds) {
    const ids = [...new Set(chatIds)];
    const out = new Map(ids.map(id => [id, { contacts: [], phoneJid: null }]));
    if (!ids.length) return out;
    const marks = list => list.map(() => '?').join(',');
    const aliases = db.prepare(`SELECT lid, phone_jid FROM wa_lid_map WHERE account_id=? AND (phone_jid IN (${marks(ids)}) OR lid IN (${marks(ids)}))`)
      .all(accountId, ...ids, ...ids);
    const aliasOf = new Map();
    for (const { lid, phone_jid: pn } of aliases) {
      if (out.has(pn)) { (aliasOf.get(pn) || aliasOf.set(pn, []).get(pn)).push(lid); }
      if (out.has(lid)) { (aliasOf.get(lid) || aliasOf.set(lid, []).get(lid)).push(pn); out.get(lid).phoneJid = pn; }
    }
    const wanted = [...new Set([...ids, ...[...aliasOf.values()].flat()])];
    const byId = new Map(db.prepare(`SELECT * FROM wa_contacts WHERE account_id=? AND contact_id IN (${marks(wanted)})`).all(accountId, ...wanted).map(row => [row.contact_id, row]));
    for (const id of ids) {
      const entry = out.get(id);
      entry.contacts = [id, ...(aliasOf.get(id) || [])].map(key => byId.get(key)).filter(Boolean);
    }
    return out;
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
        contact.name ?? null,
        contact.picture ?? null,
        contact.phone ?? null,
        now(),
        contact.pushName ?? contact.notify ?? null,
        contact.verifiedName ?? null,
      );
    }
  }

  function setContactPicture(accountId, contactId, pictureUrl) {
    stmt.upsertContact.run(accountId, contactId, null, pictureUrl, null, now(), null, null);
  }

  // Everything outside the conversation list just wants "a name for this contact": the contact
  // name, else the verified business name, else the push name.
  const withBestName = row => (row ? { ...row, name: row.name || row.verified_name || row.push_name || null } : null);

  function getContact(accountId, contactId) {
    return withBestName(stmt.getContact.get(accountId, contactId));
  }

  function getContacts(accountId) {
    return stmt.listContacts.all(accountId).map(withBestName);
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
    db.prepare(`DELETE FROM wa_starred WHERE account_id=?`).run(accountId);
    db.prepare(`DELETE FROM wa_blocklist WHERE account_id=?`).run(accountId);
  }

  return {
    upsertChats, setChatPicture, setChatFlags, deleteChat, getChatsOverview, getChatOverview, listChatsPage, getContactsForChats,
    listChatIds, chatExists, ensureChat, mergeChat,
    unreadCountOf, unreadIncomingKeys, markChatRead, markMessagesReadElsewhere, hasUnread,
    upsertMessages, deleteMessage, deleteMessageAndRefreshPreview, clearChatMessages, applyEdit, getMessagesPage, getMessageById,
    setStarred, isStarred, starredMessageIds, listStarred,
    replaceBlocklist, setBlocked, isBlocked, blockedJids,
    upsertContacts, setContactPicture, getContact, getContacts,
    setLidMapping, resolveLid,
    applyReaction, getReaction,
    deleteAccountData,
  };
}


// One-time upgrade from the old stored counter: the newest N incoming messages of a chat that had
// N unread become flagged, and the cursor sits just before the oldest of them (or at the newest
// message when nothing was unread). Chats that were fully read stay read.
function backfillReadState(db) {
  const chats = db.prepare(`SELECT account_id, chat_id, unread_count FROM wa_chats`).all();
  const newest = db.prepare(`SELECT MAX(timestamp) AS ts FROM wa_messages WHERE account_id=? AND chat_id=?`);
  const recentIncoming = db.prepare(`SELECT message_id, timestamp FROM wa_messages WHERE account_id=? AND chat_id=? AND from_me=0 ORDER BY timestamp DESC LIMIT ?`);
  const flag = db.prepare(`UPDATE wa_messages SET unread=1 WHERE account_id=? AND chat_id=? AND message_id=?`);
  const cursor = db.prepare(`UPDATE wa_chats SET read_ts=? WHERE account_id=? AND chat_id=?`);
  for (const chat of chats) {
    const want = Math.max(0, Number(chat.unread_count) || 0);
    const rows = want ? recentIncoming.all(chat.account_id, chat.chat_id, want) : [];
    for (const row of rows) flag.run(chat.account_id, chat.chat_id, row.message_id);
    const boundary = rows.length ? Math.max(0, rows[rows.length - 1].timestamp - 1) : (newest.get(chat.account_id, chat.chat_id).ts || 0);
    cursor.run(boundary, chat.account_id, chat.chat_id);
  }
}
