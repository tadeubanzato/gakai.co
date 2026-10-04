// Who a conversation is, in words. ONE function decides the title of a conversation so no
// component guesses on its own.
//
// Individual conversation, first usable value wins:
//   1. contact name     — what WhatsApp's contact sync calls them (the owner's address book)
//   2. chat name        — the label WhatsApp's history sync attached to the chat
//   3. verified name    — a business's WhatsApp-verified name
//   4. push name        — the name the person chose for themselves ("notify"); self-declared,
//                         so it ranks below anything the owner or WhatsApp vouched for
//   5. formatted phone  — "+55 11 99977-7057"
//   6. the raw JID      — only when nothing else exists
// Group: the group subject (chat name), then a contact-sync name, then "Group".
//
// `contacts` is every stored contact row for this conversation — its own id first, then its
// LID/phone alias — merged field by field, so a name learned under the LID still reaches the
// phone-number chat. A null never overwrites anything upstream of here (see the store), so a
// stale or empty record cannot downgrade a good name.
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { classifyJid, JID_KIND } from './jid.mjs';

const clean = value => (typeof value === 'string' ? value.trim() : '');
// A "name" that is really just the number or the id adds nothing.
const isPlaceholderName = value => /^\+?[\d\s()-]{5,}$/.test(value) || /@(s\.whatsapp\.net|lid|g\.us)$/.test(value);
const usable = value => { const text = clean(value); return text && !isPlaceholderName(text) ? text : ''; };

export function formatPhoneNumber(digits) {
  const only = String(digits || '').replace(/\D/g, '');
  if (only.length < 6 || only.length > 15) return null;
  const parsed = parsePhoneNumberFromString(`+${only}`);
  return parsed?.isPossible() ? parsed.formatInternational() : `+${only}`;
}

// Digits of a phone-number JID (user part, minus any device suffix); null for a LID or group.
export function phoneDigitsFromJid(jid) {
  const match = /^(\d{5,15})(?::\d+)?@(s\.whatsapp\.net|hosted)$/.exec(String(jid || ''));
  return match ? match[1] : null;
}

const firstOf = (contacts, field) => {
  for (const contact of contacts || []) { const value = usable(contact?.[field]); if (value) return value; }
  return '';
};

export function resolveConversationIdentity({ chatId, chatName, contacts = [], phoneJid = null }) {
  const kind = classifyJid(chatId);
  const contactName = firstOf(contacts, 'name');
  if (kind === JID_KIND.GROUP) {
    return { kind, displayName: usable(chatName) || contactName || 'Group', phone: null };
  }
  const digits = phoneDigitsFromJid(phoneJid) || phoneDigitsFromJid(chatId)
    || (contacts || []).map(contact => String(contact?.phone || '').replace(/\D/g, '')).find(value => value.length >= 5) || null;
  const phone = formatPhoneNumber(digits);
  const displayName = contactName || usable(chatName) || firstOf(contacts, 'verified_name') || firstOf(contacts, 'push_name')
    || phone || clean(chatId);
  return { kind, displayName, phone };
}

export function resolveConversationDisplayName(input) {
  return resolveConversationIdentity(input).displayName;
}
