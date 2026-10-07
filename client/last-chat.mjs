// The conversation a reader was last in, per WhatsApp account, so a refresh reopens it instead of
// the newest one. Kept in this browser only; storage can be missing or blocked, so every call is
// allowed to do nothing.
const key = accountId => `gakai.lastChat.${accountId}`;

export function rememberChat(accountId, chatId, storage = globalThis.localStorage) {
  if (!accountId) return;
  try {
    if (chatId) storage.setItem(key(accountId), chatId);
    else storage.removeItem(key(accountId));
  } catch { /* storage unavailable: the newest conversation opens, as before */ }
}

export function recallChat(accountId, storage = globalThis.localStorage) {
  if (!accountId) return null;
  try { return storage.getItem(key(accountId)) || null; } catch { return null; }
}

// The conversation to open automatically: the remembered one if it is in the list, else the newest.
export function pickChat(chats, accountId, storage) {
  const remembered = recallChat(accountId, storage);
  return (remembered && chats.find(chat => chat.id === remembered)) || chats[0];
}
