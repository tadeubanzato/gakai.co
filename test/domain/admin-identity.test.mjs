import assert from 'node:assert/strict';
import test from 'node:test';
import { loginNamesAdmin, normalizeEmail } from '../../src/domain/admin-identity.mjs';

test('normalizeEmail lowercases and trims a valid address, and treats blank as "no email"', () => {
  assert.equal(normalizeEmail('  Tadeu@Example.COM '), 'tadeu@example.com');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail('   '), '');
  assert.equal(normalizeEmail(undefined), '');
});

test('normalizeEmail rejects anything that is not an email address', () => {
  for (const bad of ['tadeu', 'tadeu@', '@example.com', 'tadeu@example', 'a b@example.com', 'a@@example.com', `${'a'.repeat(250)}@example.com`]) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
});

test('login matches the username exactly or the email in any case, and nothing else', () => {
  const admin = { username: 'admin', email: 'tadeu@example.com' };
  assert.equal(loginNamesAdmin(admin, 'admin'), true);
  assert.equal(loginNamesAdmin(admin, ' admin '), true);
  assert.equal(loginNamesAdmin(admin, 'Admin'), false, 'the username stays case-sensitive, as before');
  assert.equal(loginNamesAdmin(admin, 'Tadeu@Example.com'), true);
  assert.equal(loginNamesAdmin(admin, 'someone@example.com'), false);
  assert.equal(loginNamesAdmin(admin, ''), false);
});

test('with no email saved, only the username signs in', () => {
  assert.equal(loginNamesAdmin({ username: 'admin', email: null }, 'admin'), true);
  assert.equal(loginNamesAdmin({ username: 'admin', email: null }, 'tadeu@example.com'), false);
  assert.equal(loginNamesAdmin({ username: 'admin', email: '' }, ''), false);
});
