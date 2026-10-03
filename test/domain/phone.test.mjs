import assert from 'node:assert/strict';
import test from 'node:test';
import { callingCodeOf, normalizePhone, resolveCallingCode } from '../../src/domain/phone.mjs';

const digits = (input, options) => normalizePhone(input, options).digits;

test('a number written with + is taken as written, in any punctuation', () => {
  for (const typed of ['+18577075969', '+1 857 707 5969', '+1 (857) 707-5969', ' +1-857-707-5969 ']) assert.equal(digits(typed), '18577075969', typed);
  for (const typed of ['+5511999777057', '+55 11 99977-7057', '+55 (11) 99977 7057']) assert.equal(digits(typed), '5511999777057', typed);
});

test('00 is the international prefix, the same as +', () => {
  assert.equal(digits('0055 11 99977 7057'), '5511999777057');
  assert.equal(digits('001 857 707 5969'), '18577075969');
});

test('a number that already starts with its country code works without the +', () => {
  assert.equal(digits('18577075969'), '18577075969');
  assert.equal(digits('1 857 707 5969'), '18577075969');
  assert.equal(digits('5511999777057'), '5511999777057');
  assert.equal(digits('55 11 99977-7057'), '5511999777057');
});

test('a national number is completed with the country code given in the request: 1, +1, 55, +55 or BR/US', () => {
  assert.equal(digits('(857) 707-5969', { countryCode: '1' }), '18577075969');
  assert.equal(digits('857-707-5969', { countryCode: '+1' }), '18577075969');
  assert.equal(digits('857 707 5969', { countryCode: 'us' }), '18577075969');
  assert.equal(digits('11 99977-7057', { countryCode: '55' }), '5511999777057');
  assert.equal(digits('(11) 99977-7057', { countryCode: '+55' }), '5511999777057');
  assert.equal(digits('11999777057', { countryCode: 'BR' }), '5511999777057');
});

test('the Brazilian trunk 0 in front of the area code is dropped', () => {
  assert.equal(digits('011 99977-7057', { countryCode: '55' }), '5511999777057');
});

test('naming the country does not break a number that already includes it', () => {
  assert.equal(digits('5511999777057', { countryCode: '55' }), '5511999777057');
  assert.equal(digits('18577075969', { countryCode: '1' }), '18577075969');
});

test('with no country code in the request, the account\'s own country fills in a national number', () => {
  assert.equal(digits('(857) 707-5969', { defaultCallingCode: '1' }), '18577075969');
  assert.equal(digits('11 99977-7057', { defaultCallingCode: '55' }), '5511999777057');
  assert.equal(digits('+55 11 99977-7057', { defaultCallingCode: '1' }), '5511999777057', 'an explicit + beats the account default');
  assert.equal(digits('5511999777057', { defaultCallingCode: '1' }), '5511999777057', 'a full number is not re-read as national');
});

test('the request\'s country code wins over the account default', () => {
  assert.equal(digits('11 99977-7057', { countryCode: '55', defaultCallingCode: '1' }), '5511999777057');
});

test('a national number with no way to place it is refused, never guessed', () => {
  for (const typed of ['(857) 707-5969', '857-707-5969', '11 99977-7057', '11999777057']) {
    const result = normalizePhone(typed);
    assert.equal(result.digits, undefined, typed);
    assert.match(result.error, /country code/i, typed);
  }
});

test('junk, too-short and too-long numbers are refused', () => {
  for (const typed of ['', '   ', 'abc', '+', '+12345', '123', '+1234567890123456']) assert.ok(normalizePhone(typed).error, JSON.stringify(typed));
  assert.match(normalizePhone('857 707 5969', { countryCode: '999' }).error, /countryCode/);
  assert.match(normalizePhone('857 707 5969', { countryCode: 'zz' }).error, /countryCode/);
});

test('reports the country and a clean +E.164 form', () => {
  assert.deepEqual(normalizePhone('+55 11 99977-7057'), { digits: '5511999777057', e164: '+5511999777057', country: 'BR' });
  assert.deepEqual(normalizePhone('+1 857 707 5969'), { digits: '18577075969', e164: '+18577075969', country: 'US' });
});

test('resolveCallingCode understands codes with or without +, and country names', () => {
  assert.equal(resolveCallingCode('1'), '1');
  assert.equal(resolveCallingCode('+55'), '55');
  assert.equal(resolveCallingCode('BR'), '55');
  assert.equal(resolveCallingCode('us'), '1');
  assert.equal(resolveCallingCode('999'), null);
  assert.equal(resolveCallingCode('Brazil'), null);
  assert.equal(resolveCallingCode(''), null);
});

test('callingCodeOf reads the country from a full number such as the connected account\'s', () => {
  assert.equal(callingCodeOf('18577075969'), '1');
  assert.equal(callingCodeOf('5511999777057'), '55');
  assert.equal(callingCodeOf(null), null);
  assert.equal(callingCodeOf('abc'), null);
});
