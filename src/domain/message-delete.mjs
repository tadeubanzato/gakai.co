// How a delete should reach WhatsApp, and how a deletion WhatsApp reports is read.
import { normalizedTimestamp } from './message.mjs';

// Your own message can be deleted for everyone (a revoke). Someone else's can
// only be deleted for you — WhatsApp ignores a revoke of a message you did not
// send — and "delete for you" is what also removes it from your phone and your
// other linked devices. A message Gakai has no record of is assumed to be yours
// (the only kind a revoke can work on).
export function planMessageDelete(target, { chatId, messageId }) {
  if (!target?.key) return { mode: 'revoke', key: { remoteJid: chatId, id: messageId, fromMe: true } };
  if (target.key.fromMe) return { mode: 'revoke', key: target.key };
  const timestamp = normalizedTimestamp(target.messageTimestamp) || Math.floor(Date.now() / 1000);
  return { mode: 'forMe', key: target.key, timestamp };
}

// Baileys reports deletions made on the phone or another linked device as
// `{ keys }` (specific messages) or `{ jid, all: true }` (a chat cleared).
export function keysFromDeleteEvent(event) {
  if (!Array.isArray(event?.keys)) return [];
  return event.keys.filter(key => key?.id && key.remoteJid).map(key => ({ remoteJid: key.remoteJid, id: key.id }));
}

// What Baileys needs to delete a whole chat: the newest message and its time as
// a plain number. A stored message has been through JSON, so its timestamp can
// be a Long-shaped object that must be flattened first.
export function chatDeleteRange(lastMessage) {
  const timestamp = normalizedTimestamp(lastMessage?.messageTimestamp);
  if (!lastMessage?.key?.id || !lastMessage.key.remoteJid || !timestamp) return [];
  return [{ key: lastMessage.key, messageTimestamp: timestamp }];
}
