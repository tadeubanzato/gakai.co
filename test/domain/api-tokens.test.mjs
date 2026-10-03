import assert from 'node:assert/strict';
import test from 'node:test';
import { newToken, publicToken, sendTarget, tokenLast4, validMessageText, validateTokenRequest } from '../../src/domain/api-tokens.mjs';

test('a new token is long, unguessable, prefixed, and different every time', () => {
  const a = newToken(), b = newToken();
  assert.match(a, /^wh_live_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a, b);
  assert.equal(tokenLast4('wh_live_abcdefgh'), 'efgh');
});

test('a token request needs a name and defaults to the least privilege (send only)', () => {
  assert.deepEqual(validateTokenRequest({ name: '  n8n  ' }), { name: 'n8n', scopes: ['messages:send'] });
  assert.deepEqual(validateTokenRequest({ name: 'CRM', scopes: ['messages:read', 'messages:send', 'messages:send'] }), { name: 'CRM', scopes: ['messages:read', 'messages:send'] });
  assert.match(validateTokenRequest({ name: '   ' }).error, /name/i);
  assert.match(validateTokenRequest({ name: 'x'.repeat(81) }).error, /80/);
});

test('unknown or empty permissions are refused, so a token can never grant more than the API understands', () => {
  for (const scopes of [[], ['admin'], ['messages:send', 'root'], 'messages:send', null]) {
    assert.match(validateTokenRequest({ name: 'app', scopes }).error, /permission/i, JSON.stringify(scopes));
  }
});

test('publicToken never exposes the secret or its hash', () => {
  const shown = publicToken({ id: 'k1', name: 'n8n', scopes: ['messages:send'], createdAt: 'c', lastUsedAt: null, last4: 'wxyz', hash: 'secret-hash', token: 'wh_live_secret' });
  assert.deepEqual(shown, { id: 'k1', name: 'n8n', scopes: ['messages:send'], createdAt: 'c', lastUsedAt: null, rotatedAt: null, last4: 'wxyz', copyable: false, copyableUntil: null });
  assert.equal(JSON.stringify(shown).includes('secret'), false);
});

test('sendTarget accepts a phone in any format under "phone" or "to", or an explicit chat id', () => {
  assert.equal(sendTarget({ phone: '+1 (857) 707-5969' }).phone, '18577075969');
  assert.equal(sendTarget({ to: 5511999777057 }).phone, '5511999777057');
  assert.deepEqual(sendTarget({ chatId: '5511999777057@s.whatsapp.net' }), { chatId: '5511999777057@s.whatsapp.net' });
  assert.deepEqual(sendTarget({ chatId: '120363025246125486@g.us', phone: '15551234567' }), { chatId: '120363025246125486@g.us' }, 'an explicit chat id wins');
});

test('sendTarget uses countryCode (1, +1, 55, +55, US, BR) for a national number, and reports the clean number', () => {
  assert.deepEqual(sendTarget({ phone: '(857) 707-5969', countryCode: '1' }), { phone: '18577075969', e164: '+18577075969', country: 'US' });
  assert.equal(sendTarget({ phone: '11 99977-7057', countryCode: '+55' }).phone, '5511999777057');
  assert.equal(sendTarget({ phone: '11999777057', countryCode: 'BR' }).phone, '5511999777057');
});

test('sendTarget falls back to the account\'s own country for a national number, but never guesses without one', () => {
  assert.equal(sendTarget({ phone: '(857) 707-5969' }, { defaultCallingCode: '1' }).phone, '18577075969');
  assert.match(sendTarget({ phone: '(857) 707-5969' }).error, /country code/i);
  assert.match(sendTarget({ phone: '(857) 707-5969', countryCode: '999' }).error, /countryCode/);
});

test('sendTarget rejects a missing target, a bad number and a malformed chat id', () => {
  assert.match(sendTarget({}).error, /phone/);
  assert.ok(sendTarget({ phone: 'abc' }).error);
  assert.match(sendTarget({ phone: '123' }).error, /country code/i);
  assert.match(sendTarget({ chatId: 'not a jid' }).error, /chat id/);
});

test('message text must be a non-empty string within the WhatsApp-friendly limit', () => {
  assert.deepEqual(validMessageText('Hello'), { text: 'Hello' });
  for (const bad of ['', '   ', undefined, 42, null, {}]) assert.ok(validMessageText(bad).error, String(bad));
  assert.match(validMessageText('x'.repeat(4097)).error, /4096/);
  assert.deepEqual(validMessageText('x'.repeat(4096)), { text: 'x'.repeat(4096) });
});

import { validateScopes } from '../../src/domain/api-tokens.mjs';

test('validateScopes accepts known permissions once each, and refuses none, unknown or non-lists', () => {
  assert.deepEqual(validateScopes(['messages:read', 'messages:send', 'messages:read']), { scopes: ['messages:read', 'messages:send'] });
  assert.deepEqual(validateScopes(['messages:send']), { scopes: ['messages:send'] });
  for (const bad of [[], ['admin'], ['messages:send', 'root'], 'messages:send', null, undefined]) assert.match(validateScopes(bad).error, /permission/i, JSON.stringify(bad));
});

import { COPY_WINDOW_MS, copyDeadline, isCopyable, pruneExpiredTokens } from '../../src/domain/api-tokens.mjs';

const HOUR = 60 * 60 * 1000;
const issued = '2026-10-02T12:00:00.000Z';
const at = ms => Date.parse(issued) + ms;

test('the copy window is 24 hours from creation, or from the last regeneration', () => {
  assert.equal(COPY_WINDOW_MS, 24 * HOUR);
  assert.equal(copyDeadline({ createdAt: issued }), at(24 * HOUR));
  assert.equal(copyDeadline({ createdAt: issued, rotatedAt: '2026-10-03T06:00:00.000Z' }), Date.parse('2026-10-04T06:00:00.000Z'), 'regenerating restarts the clock');
  assert.equal(copyDeadline({}), 0);
});

test('a token is copyable only while it is stored and inside the window', () => {
  const key = { createdAt: issued, tokenEnc: 'cipher' };
  assert.equal(isCopyable(key, at(0)), true);
  assert.equal(isCopyable(key, at(24 * HOUR - 1)), true);
  assert.equal(isCopyable(key, at(24 * HOUR)), false, 'closed exactly at 24 hours');
  assert.equal(isCopyable({ createdAt: issued }, at(HOUR)), false, 'an old token with nothing stored is never copyable');
});

test('pruneExpiredTokens deletes the stored token of expired keys only', () => {
  const fresh = { id: 'a', createdAt: issued, tokenEnc: 'x' };
  const stale = { id: 'b', createdAt: issued, tokenEnc: 'y' };
  const bare = { id: 'c', createdAt: issued };
  const now = at(25 * HOUR);
  fresh.createdAt = new Date(now - HOUR).toISOString();
  assert.equal(pruneExpiredTokens([fresh, stale, bare], now), 1);
  assert.equal(fresh.tokenEnc, 'x');
  assert.equal('tokenEnc' in stale, false);
});

test('publicToken reports copyability but never the stored token', () => {
  const key = { id: 'k', name: 'n8n', scopes: ['messages:send'], createdAt: issued, last4: 'wxyz', tokenEnc: 'cipher-secret', hash: 'h' };
  const open = publicToken(key, at(HOUR));
  assert.equal(open.copyable, true);
  assert.equal(open.copyableUntil, new Date(at(24 * HOUR)).toISOString());
  assert.equal(JSON.stringify(open).includes('cipher-secret'), false);
  const closed = publicToken(key, at(30 * HOUR));
  assert.deepEqual([closed.copyable, closed.copyableUntil], [false, null]);
});
