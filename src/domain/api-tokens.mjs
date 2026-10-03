// Application tokens: how another system (n8n, a CRM, a script) authenticates to
// Gakai's HTTP API to send a WhatsApp message from one connected account.
import { randomBytes } from 'node:crypto';
import { normalizePhone } from './phone.mjs';

export const TOKEN_SCOPES = ['messages:send', 'messages:read'];
export const MAX_TOKENS_PER_ACCOUNT = 20;
export const MAX_MESSAGE_LENGTH = 4096;
// A token can be copied back out of Gakai for this long after it is created or
// regenerated. After that only its one-way hash is kept, so it can never be read again.
export const COPY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Keys Gakai manages for itself (the n8n auto-connect); they are not listed or
// rotated from the tokens card.
export const INTERNAL_KEY_NAMES = new Set(['n8n integration']);

export const newToken = () => `wh_live_${randomBytes(24).toString('base64url')}`;
export const tokenLast4 = token => String(token).slice(-4);

// What a token may do: known permissions only, at least one (a token that can do
// nothing is useless), no duplicates.
export function validateScopes(requested) {
  if (!Array.isArray(requested) || !requested.length || requested.some(scope => !TOKEN_SCOPES.includes(scope))) {
    return { error: `Choose at least one permission: ${TOKEN_SCOPES.join(', ')}` };
  }
  return { scopes: [...new Set(requested)] };
}

// A name for the application plus what it may do. Least privilege by default:
// a token that is not told otherwise can only send.
export function validateTokenRequest(input) {
  const name = String(input?.name ?? '').trim();
  if (!name) return { error: 'Give the token a name, such as the application that will use it' };
  if (name.length > 80) return { error: 'Use a name up to 80 characters' };
  const checked = validateScopes(input?.scopes === undefined ? ['messages:send'] : input.scopes);
  return checked.error ? { error: checked.error } : { name, scopes: checked.scopes };
}

// When the copy window closes: 24 hours after the token was created or last regenerated.
export function copyDeadline(key) {
  const issued = Date.parse(key?.rotatedAt || key?.createdAt || '');
  return Number.isFinite(issued) ? issued + COPY_WINDOW_MS : 0;
}

// Copyable = Gakai still holds the (encrypted) token and the window is open. Tokens
// made before copying existed have nothing stored, so they are never copyable.
export function isCopyable(key, now = Date.now()) {
  return Boolean(key?.tokenEnc) && now < copyDeadline(key);
}

// Drop the stored token from every key whose window has closed. Returns how many.
export function pruneExpiredTokens(keys, now = Date.now()) {
  let pruned = 0;
  for (const key of keys) {
    if (key.tokenEnc && !isCopyable(key, now)) { delete key.tokenEnc; pruned += 1; }
  }
  return pruned;
}

// What the browser may know about a token: never the secret, its hash, or the
// stored ciphertext — only whether it can still be copied, and until when.
export function publicToken(key, now = Date.now()) {
  const copyable = isCopyable(key, now);
  return {
    id: key.id, accountId: key.accountId || null, name: key.name, scopes: key.scopes || [], createdAt: key.createdAt || null,
    lastUsedAt: key.lastUsedAt || null, rotatedAt: key.rotatedAt || null, last4: key.last4 || null,
    copyable, copyableUntil: copyable ? new Date(copyDeadline(key)).toISOString() : null,
  };
}

const CHAT_ID = /^[0-9a-z._-]+@(s\.whatsapp\.net|g\.us|lid)$/i;

// Who the message goes to: a phone number (`phone` or `to`, in any format, see
// phone.mjs) or an explicit chat id. An explicit chat id wins when both are sent.
// `defaultCallingCode` is the connected account's own country, used only for a
// national number the request did not give a `countryCode` for.
export function sendTarget(input, { defaultCallingCode } = {}) {
  const chatId = String(input?.chatId ?? '').trim();
  if (chatId) return CHAT_ID.test(chatId) ? { chatId } : { error: 'chatId is not a valid WhatsApp chat id' };
  const raw = input?.phone ?? input?.to;
  if (raw === undefined || raw === null || String(raw).trim() === '') return { error: 'Send a phone number (international format) as "phone", or a "chatId"' };
  const number = normalizePhone(raw, { countryCode: input?.countryCode, defaultCallingCode });
  return number.error ? { error: number.error } : { phone: number.digits, e164: number.e164, country: number.country };
}

export function validMessageText(value) {
  if (typeof value !== 'string' || !value.trim()) return { error: '"text" is required' };
  if (value.length > MAX_MESSAGE_LENGTH) return { error: `"text" can be at most ${MAX_MESSAGE_LENGTH} characters` };
  return { text: value };
}
