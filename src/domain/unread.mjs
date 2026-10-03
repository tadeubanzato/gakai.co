// When does a message count as unread? These rules are the whole definition, kept pure so they
// can be tested without WhatsApp. The count a conversation shows is derived from the messages
// flagged here — never a counter that events can overwrite.
//
//   • Only INCOMING messages with real content count (not your own, not group-event stubs).
//   • A message is judged ONCE, when it is first stored; seeing it again never changes the verdict.
//   • History sync never makes anything unread: those messages are old by definition.
//   • A message at or before the conversation's read cursor is already read.
export const WA_STATUS_READ = 4;   // proto.WebMessageInfo.Status.READ

// A normalized Gakai message that a person would want a badge for.
export function countsAsUnread(message) {
  if (!message || message.fromMe) return false;
  return Boolean(message.body || message.text || message.hasMedia || message.system?.kind === 'call');
}

// `source` is 'live' for messages that arrive in real time or are delivered after a reconnect
// (Baileys marks those 'notify' and 'append'), and 'history' for the history sync.
export function startsUnread({ source, message, readCursor = 0 }) {
  if (source !== 'live' || !countsAsUnread(message)) return false;
  return Number(message.timestamp) > Number(readCursor || 0);
}

// A message-status update that says: this INCOMING message was read — on another device.
// (An outgoing message being read by the other person has key.fromMe = true; that is not ours.)
export function isReadElsewhere({ key, update }) {
  return Boolean(key?.id && key.remoteJid && key.fromMe === false && Number(update?.status) >= WA_STATUS_READ);
}
