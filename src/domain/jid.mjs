// The one place that decides what kind of WhatsApp identity a JID is, and which kinds
// belong in the conversation list. Ingestion, the store query and the API all use this;
// nothing else should string-match a JID suffix.
import {
  isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, isPnUser, isLidUser,
  isHostedPnUser, isHostedLidUser, isJidBot, isJidMetaAI,
} from '@whiskeysockets/baileys';

export const JID_KIND = Object.freeze({
  INDIVIDUAL: 'individual',   // a person: phone-number JID or LID
  GROUP: 'group',
  STATUS: 'status',           // status@broadcast — WhatsApp Status, never a conversation
  BROADCAST: 'broadcast',     // a broadcast list (<id>@broadcast)
  NEWSLETTER: 'newsletter',   // a channel
  BOT: 'bot',                 // Meta AI and other bots
  UNSUPPORTED: 'unsupported', // anything else, including an empty or malformed id
});

export function classifyJid(jid) {
  const value = typeof jid === 'string' ? jid.trim() : '';
  if (!value) return JID_KIND.UNSUPPORTED;
  if (isJidStatusBroadcast(value)) return JID_KIND.STATUS;
  if (isJidBroadcast(value)) return JID_KIND.BROADCAST;
  if (isJidGroup(value)) return JID_KIND.GROUP;
  if (isJidNewsletter(value)) return JID_KIND.NEWSLETTER;
  if (isJidBot(value) || isJidMetaAI(value)) return JID_KIND.BOT;
  if (isPnUser(value) || isLidUser(value) || isHostedPnUser(value) || isHostedLidUser(value)) return JID_KIND.INDIVIDUAL;
  return JID_KIND.UNSUPPORTED;
}

const DISPLAYABLE = new Set([JID_KIND.INDIVIDUAL, JID_KIND.GROUP]);

// Conversations Gakai shows: people and groups.
export function isDisplayableConversation(jid) {
  return DISPLAYABLE.has(classifyJid(jid));
}

// The same rule as SQL, so a page query can filter BEFORE it applies LIMIT (filtering after
// would return fewer rows than asked for). Anything displayable ends in one of these domains;
// the unit test keeps this in step with isDisplayableConversation.
export const DISPLAYABLE_JID_DOMAINS = Object.freeze(['@s.whatsapp.net', '@lid', '@g.us', '@hosted', '@hosted.lid']);
export const DISPLAYABLE_JID_SQL = `(${DISPLAYABLE_JID_DOMAINS.map(domain => `chat_id LIKE '%${domain}'`).join(' OR ')})`;
