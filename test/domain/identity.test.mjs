import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConversationDisplayName, resolveConversationIdentity, formatPhoneNumber } from '../../src/domain/identity.mjs';

const PN = '5511999777057@s.whatsapp.net';
const name = input => resolveConversationDisplayName({ chatId: PN, ...input });

test('a contact name beats everything else', () => {
  assert.equal(name({ chatName: 'Chat Label', contacts: [{ name: 'Saved Name', push_name: 'pushy', verified_name: 'Biz' }] }), 'Saved Name');
});

test('order below the contact name: chat label, verified name, push name', () => {
  assert.equal(name({ chatName: 'Chat Label', contacts: [{ push_name: 'pushy', verified_name: 'Biz' }] }), 'Chat Label');
  assert.equal(name({ contacts: [{ push_name: 'pushy', verified_name: 'Biz' }] }), 'Biz');
  assert.equal(name({ contacts: [{ push_name: 'pushy' }] }), 'pushy');
});

test('a push-name-only contact is shown by that name', () => {
  assert.equal(name({ contacts: [{ push_name: 'Ana from work' }] }), 'Ana from work');
});

test('with no name at all the formatted phone number is shown, not the JID', () => {
  assert.equal(name({ contacts: [] }), '+55 11 99977 7057');
  assert.equal(resolveConversationIdentity({ chatId: PN }).phone, '+55 11 99977 7057');
});

test('a "name" that is only the number or the JID does not count as a name', () => {
  assert.equal(name({ chatName: PN, contacts: [{ name: '5511999777057' }, { push_name: '+55 11 99977-7057' }] }), '+55 11 99977 7057');
});

test('the raw JID is the last resort, for an id with no phone number in it', () => {
  assert.equal(resolveConversationDisplayName({ chatId: '123456789012345@lid', contacts: [] }), '123456789012345@lid');
});

test('a LID chat borrows the phone number and name of its mapped phone-number identity', () => {
  const identity = resolveConversationIdentity({ chatId: '99887766@lid', phoneJid: PN, contacts: [{ push_name: 'Via Lid' }] });
  assert.equal(identity.displayName, 'Via Lid');
  assert.equal(identity.phone, '+55 11 99977 7057');
  assert.equal(resolveConversationDisplayName({ chatId: '99887766@lid', phoneJid: PN, contacts: [] }), '+55 11 99977 7057');
});

test('a group is named by its subject; a contact-sync name is next; never a person-style fallback', () => {
  const group = '120363000000000000@g.us';
  assert.equal(resolveConversationDisplayName({ chatId: group, chatName: 'Family', contacts: [{ push_name: 'x' }] }), 'Family');
  assert.equal(resolveConversationDisplayName({ chatId: group, contacts: [{ name: 'Synced Group' }] }), 'Synced Group');
  assert.equal(resolveConversationDisplayName({ chatId: group, contacts: [] }), 'Group');
});

test('formatPhoneNumber rejects things that are not phone numbers', () => {
  assert.equal(formatPhoneNumber('12'), null);
  assert.equal(formatPhoneNumber(''), null);
});
