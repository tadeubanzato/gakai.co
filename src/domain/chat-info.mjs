// What the details window shows about a person or a group, shaped from what WhatsApp returns. Pure
// functions: the provider adapter does the lookups and hands the raw results here, so the shapes the
// browser sees stay Gakai's own and never carry provider-specific objects.
import { formatPhoneNumber } from './identity.mjs';

export const MAX_INFO_MEMBERS = 1100;

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const iso = seconds => {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
};

// `status` is what WhatsApp calls the About line; an empty or hidden one is simply absent.
export function personInfoView({ id, name, phone, picture, about, aboutSetAt, business }) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const site = Array.isArray(business?.website) ? business.website.filter(Boolean) : [];
  const hasBusiness = business && (text(business.description) || text(business.email) || text(business.address) || text(business.category) || site.length);
  return {
    kind: 'person',
    id,
    name: text(name) || (digits ? formatPhoneNumber(digits) : null),
    phone: digits || null,
    phoneLabel: digits ? formatPhoneNumber(digits) : null,
    picture: picture || null,
    about: text(about),
    aboutSetAt: aboutSetAt ? iso(new Date(aboutSetAt).getTime() / 1000) : null,
    business: hasBusiness
      ? { description: text(business.description), email: text(business.email), address: text(business.address), category: text(business.category), website: site }
      : null,
  };
}

// `describe(rawId)` turns a participant id into { id, number, name, isMe } using what Gakai already knows
// (contacts, the id-to-number mapping); this only arranges the result.
export function groupInfoView(metadata, describe, picture = null) {
  const members = (metadata?.participants || []).slice(0, MAX_INFO_MEMBERS).map(participant => {
    const rawId = participant.id || participant.jid;
    const person = rawId ? describe(rawId) : null;
    if (!person) return null;
    const admin = participant.admin === 'superadmin' || participant.isSuperAdmin ? 'superadmin' : participant.admin === 'admin' || participant.isAdmin ? 'admin' : null;
    return { ...person, admin };
  }).filter(Boolean);
  const rank = member => (member.isMe ? 0 : member.admin ? 1 : 2);
  members.sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
  const owner = metadata?.owner ? describe(metadata.owner) : null;
  return {
    kind: 'group',
    id: metadata?.id || null,
    name: text(metadata?.subject) || 'Group',
    picture: picture || null,
    description: text(metadata?.desc),
    createdAt: iso(metadata?.creation),
    createdBy: owner ? { id: owner.id, name: owner.isMe ? 'You' : owner.name } : null,
    memberCount: Number(metadata?.size) > 0 ? Number(metadata.size) : members.length,
    onlyAdminsCanWrite: Boolean(metadata?.announce),
    onlyAdminsCanEdit: Boolean(metadata?.restrict),
    disappearingSeconds: Number(metadata?.ephemeralDuration) > 0 ? Number(metadata.ephemeralDuration) : 0,
    isCommunity: Boolean(metadata?.isCommunity),
    members,
  };
}
