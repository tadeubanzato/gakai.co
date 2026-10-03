// Type-ahead data for the AI reply list: find people and groups from the
// account's own conversations (and contacts) as the user types, and name the
// entries already saved. Pure functions over plain rows so they are testable.
import { normalizeGroupId, normalizePhoneNumber } from './ai-reply-rules.mjs';

const DEFAULT_LIMIT = 8;
const fold = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PHONE_JID = /@s\.whatsapp\.net$/;
const phoneOfJid = jid => normalizePhoneNumber(String(jid || '').replace(/@.*$/, '').replace(/:\d+$/, ''));

// A query "looks like a phone number" when it is only digits and phone
// punctuation — "+55 (11) 9", "857", "0011". Anything with letters is a name.
function phoneQuery(query) {
  const text = String(query ?? '').trim();
  if (!/^[\d\s()+\-.]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 2 ? digits : null;
}

// One row per person: conversations first (most recent first), then contacts
// that have never been messaged. `contacts` rows may use `id` or `contact_id`.
function people({ chats, contacts }) {
  const names = new Map();
  for (const contact of contacts || []) {
    const phone = normalizePhoneNumber(contact.phone) || phoneOfJid(contact.id || contact.contact_id);
    if (phone && contact.name && !names.has(phone)) names.set(phone, contact.name);
  }
  const byPhone = new Map();
  const directChats = (chats || []).filter(chat => PHONE_JID.test(String(chat.id || ''))).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  for (const chat of directChats) {
    const phone = phoneOfJid(chat.id);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, { phone, name: chat.name || names.get(phone) || null, inChats: true });
  }
  const others = [...names].filter(([phone]) => !byPhone.has(phone)).sort((a, b) => a[1].localeCompare(b[1]));
  for (const [phone, name] of others) byPhone.set(phone, { phone, name, inChats: false });
  return [...byPhone.values()];
}

const personOption = person => ({ value: person.phone, label: person.name || `+${person.phone}`, detail: person.name ? `+${person.phone}` : null });

export function searchPeople({ chats, contacts, query, exclude = [], limit = DEFAULT_LIMIT }) {
  const taken = new Set(exclude.map(normalizePhoneNumber).filter(Boolean));
  const asPhone = phoneQuery(query);
  const text = fold(String(query ?? '').trim());
  const everyone = people({ chats, contacts }).filter(person => !taken.has(person.phone));
  const matches = !text ? everyone.filter(person => person.inChats)
    : asPhone ? everyone.filter(person => person.phone.includes(asPhone))
      : everyone.filter(person => fold(person.name).includes(text));
  const results = matches.slice(0, limit).map(personOption);
  // A number that is in no conversation can still be added by typing it — but
  // only when nothing matches, so a half-typed known number is never offered.
  const typed = asPhone ? normalizePhoneNumber(query) : null;
  if (typed && !taken.has(typed) && !matches.length) {
    results.push({ value: typed, label: `+${typed}`, detail: 'Add this number', custom: true });
  }
  return results;
}

export function searchGroups({ chats, query, exclude = [], limit = DEFAULT_LIMIT }) {
  const taken = new Set(exclude.map(normalizeGroupId).filter(Boolean));
  const text = fold(String(query ?? '').trim());
  const groups = (chats || []).filter(chat => /@g\.us$/.test(String(chat.id || ''))).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).filter(chat => !taken.has(chat.id));
  const matches = !text ? groups : groups.filter(chat => fold(chat.name).includes(text) || chat.id.includes(text));
  const results = matches.slice(0, limit).map(chat => ({ value: chat.id, label: chat.name || chat.id.replace(/@g\.us$/, ''), detail: chat.name ? chat.id.replace(/@g\.us$/, '') : null }));
  // A long id that is not in the chat list yet (a group joined on another device).
  const typed = /^[0-9-]{10,}(@g\.us)?$/i.test(String(query ?? '').trim()) ? normalizeGroupId(query) : null;
  if (typed && !taken.has(typed) && !matches.length) {
    results.push({ value: typed, label: typed.replace(/@g\.us$/, ''), detail: 'Add this group ID', custom: true });
  }
  return results;
}

// Names for the entries already saved, so a tag can say "Marina" and not a number.
export function resolveRuleLabels(rules, { chats, contacts }) {
  const known = new Map(people({ chats, contacts }).map(person => [person.phone, person.name]));
  const groupNames = new Map((chats || []).filter(chat => /@g\.us$/.test(String(chat.id || ''))).map(chat => [chat.id, chat.name || null]));
  return {
    numbers: Object.fromEntries((rules?.numbers || []).map(phone => [phone, known.get(phone) || null])),
    groups: Object.fromEntries((rules?.groups || []).map(id => [id, groupNames.get(id) || null])),
  };
}
