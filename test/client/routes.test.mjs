import assert from 'node:assert/strict';
import test from 'node:test';
import { accountSlug, findAccountBySlug, parseRoute, profilePath, slugify } from '../../client/routes.mjs';

test('the home page, the settings page and a profile page are told apart', () => {
  assert.deepEqual(parseRoute('/'), { view: 'home' });
  assert.deepEqual(parseRoute(''), { view: 'home' });
  assert.deepEqual(parseRoute('/settings'), { view: 'settings' });
  assert.deepEqual(parseRoute('/settings/'), { view: 'settings' }, 'a trailing slash changes nothing');
  assert.deepEqual(parseRoute('/profile-settings/tadeu'), { view: 'profile', slug: 'tadeu', tab: 'connection' });
});

test('a profile page can name a tab; an unknown tab falls back to the first', () => {
  assert.equal(parseRoute('/profile-settings/tadeu/ai').tab, 'ai');
  assert.equal(parseRoute('/profile-settings/tadeu/automation').tab, 'automation');
  assert.equal(parseRoute('/profile-settings/tadeu/voices').tab, 'voices');
  assert.deepEqual(parseRoute('/profile-settings/tadeu/people'), { view: 'profile', slug: 'tadeu', tab: 'voices', legacy: true }, 'the old Who to reply to tab now lives in AI Voice and Tone, and the address gets rewritten');
  assert.equal(parseRoute('/profile-settings/tadeu/nonsense').tab, 'connection');
});

test('the old /details/<name> address still lands on the profile, flagged so it can be redirected', () => {
  assert.deepEqual(parseRoute('/details/tadeu'), { view: 'profile', slug: 'tadeu', tab: 'connection', legacy: true });
});

test('anything else is home, and an encoded name is decoded', () => {
  assert.deepEqual(parseRoute('/accounts/whatever'), { view: 'home' });
  assert.deepEqual(parseRoute('/profile-settings'), { view: 'home' });
  assert.equal(parseRoute('/profile-settings/m%C3%A3e').slug, 'mãe');
  assert.equal(parseRoute('/profile-settings/%E0%A4%A').slug, '%E0%A4%A', 'a broken encoding does not throw');
});

test('profilePath builds the address, leaving the default tab out', () => {
  assert.equal(profilePath('tadeu'), '/profile-settings/tadeu');
  assert.equal(profilePath('tadeu', 'connection'), '/profile-settings/tadeu');
  assert.equal(profilePath('tadeu', 'ai'), '/profile-settings/tadeu/ai');
  assert.deepEqual(parseRoute(profilePath('tadeu', 'automation')), { view: 'profile', slug: 'tadeu', tab: 'automation' });
});

test('an account is addressed by its name, and by its id when names would clash or are unusable', () => {
  const accounts = [{ id: 'account-aaa', label: 'Tadeu' }, { id: 'account-bbb', label: 'Work Phone' }, { id: 'account-ccc', label: 'tadeu' }, { id: 'account-ddd', label: '!!!' }];
  assert.equal(accountSlug(accounts[1], accounts), 'work-phone');
  assert.equal(accountSlug(accounts[0], accounts), 'account-aaa', 'two accounts called Tadeu cannot share one address');
  assert.equal(accountSlug(accounts[2], accounts), 'account-ccc');
  assert.equal(accountSlug(accounts[3], accounts), 'account-ddd', 'no letters in the name, so the id is used');
  assert.equal(slugify('  Mãe & Pai  '), 'm-e-pai');
});

test('an address finds its account by name or by id, and nothing else', () => {
  const accounts = [{ id: 'account-aaa', label: 'Tadeu' }, { id: 'account-bbb', label: 'Work Phone' }];
  assert.equal(findAccountBySlug(accounts, 'work-phone').id, 'account-bbb');
  assert.equal(findAccountBySlug(accounts, 'tadeu').id, 'account-aaa');
  assert.equal(findAccountBySlug(accounts, 'account-bbb').id, 'account-bbb', 'the id always works, so an old link survives a rename');
  assert.equal(findAccountBySlug(accounts, 'nobody'), null);
});
