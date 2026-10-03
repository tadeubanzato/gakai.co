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

// `assignments` says which voice profile each listed person or group uses: { "<phone digits or
// group id>": "<voice id>" }. Only entries still on the list count, and it is left out when empty
// so a list with no voices chosen looks exactly as it always did.
export function normalizeReplyRules(input) {
  const unique = (values, normalize) => [...new Set(toList(values).map(normalize).filter(Boolean))].slice(0, MAX_RULE_ENTRIES);
  const numbers = unique(input?.numbers, normalizePhoneNumber);
  const groups = unique(input?.groups, normalizeGroupId);
  const listed = new Set([...numbers, ...groups]);
  const given = input?.assignments && typeof input.assignments === 'object' && !Array.isArray(input.assignments) ? input.assignments : {};
  const assignments = {};
  for (const [rawKey, voiceId] of Object.entries(given)) {
    const key = /@g\.us$/i.test(rawKey) ? normalizeGroupId(rawKey) : normalizePhoneNumber(rawKey);
    if (key && listed.has(key) && typeof voiceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(voiceId)) assignments[key] = voiceId;
  }
  return Object.keys(assignments).length ? { numbers, groups, assignments } : { numbers, groups };
}

// The voice profile chosen for this person or group, or null (then the account's default
// instructions are used).
export function voiceIdFor(rules, { chatId, phone, isGroup }) {
  const { assignments = {} } = normalizeReplyRules(rules);
  const key = isGroup ? String(chatId || '').toLowerCase() : normalizePhoneNumber(phone);
  return (key && assignments[key]) || null;
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
    return normalizeReplyRules({ ...current, groups: enabled ? [...groups, id].slice(0, MAX_RULE_ENTRIES) : groups });
  }
  const number = normalizePhoneNumber(phone);
  if (!number) return null;
  const numbers = current.numbers.filter(entry => entry !== number);
  return normalizeReplyRules({ ...current, numbers: enabled ? [...numbers, number].slice(0, MAX_RULE_ENTRIES) : numbers });
}
