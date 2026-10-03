// Who the AI is allowed to answer. Opt-in by design: an account with no rules
// replies to nobody, so turning AI replies on never surprises a personal or
// group chat that was not explicitly added.
//
//   numbers — phone numbers (digits, with country code) answered in direct chats
//   groups  — group ids answered only when this account is @-tagged in them
export const MAX_RULE_ENTRIES = 200;

// "+1 (857) 707-5969" -> "18577075969". Returns null for anything that cannot
// be an international phone number.
export function normalizePhoneNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 6 && digits.length <= 15 ? digits : null;
}

// Accepts a full group jid ("1203…@g.us") or the bare id ("1203…", "5511…-1600…").
export function normalizeGroupId(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.endsWith('@g.us')) return /^[0-9-]+@g\.us$/.test(raw) ? raw : null;
  return /^[0-9-]+$/.test(raw) ? `${raw}@g.us` : null;
}

const toList = value => (Array.isArray(value) ? value : String(value ?? '').split(/[\n,;]+/));

export function normalizeReplyRules(input) {
  const unique = (values, normalize) => [...new Set(toList(values).map(normalize).filter(Boolean))].slice(0, MAX_RULE_ENTRIES);
  return {
    numbers: unique(input?.numbers, normalizePhoneNumber),
    groups: unique(input?.groups, normalizeGroupId),
  };
}

// `phone` is the contact's resolved phone number (digits) for a direct chat;
// `mentionsYou` is whether this account was @-tagged in the message.
export function shouldAiReply(rules, { chatId, phone, isGroup, mentionsYou }) {
  const normalized = normalizeReplyRules(rules);
  if (isGroup) return Boolean(mentionsYou) && normalized.groups.includes(String(chatId || '').toLowerCase());
  const number = normalizePhoneNumber(phone);
  return Boolean(number) && normalized.numbers.includes(number);
}

// Per-chat view of the same rules, for the chat menu's "AI replies" switch.
// A direct chat is identified by its contact's phone number, a group by its id.
const isGroupId = chatId => /@g\.us$/i.test(String(chatId || ''));

export function isChatListed(rules, { chatId, phone }) {
  const normalized = normalizeReplyRules(rules);
  if (isGroupId(chatId)) return normalized.groups.includes(String(chatId).toLowerCase());
  const number = normalizePhoneNumber(phone);
  return Boolean(number) && normalized.numbers.includes(number);
}

// Returns new rules with this chat added or removed; null when a direct chat's
// phone number is unknown (so the caller can say why instead of guessing).
export function setChatListed(rules, { chatId, phone }, enabled) {
  const current = normalizeReplyRules(rules);
  if (isGroupId(chatId)) {
    const id = String(chatId).toLowerCase();
    const groups = current.groups.filter(entry => entry !== id);
    return { ...current, groups: enabled ? [...groups, id].slice(0, MAX_RULE_ENTRIES) : groups };
  }
  const number = normalizePhoneNumber(phone);
  if (!number) return null;
  const numbers = current.numbers.filter(entry => entry !== number);
  return { ...current, numbers: enabled ? [...numbers, number].slice(0, MAX_RULE_ENTRIES) : numbers };
}
