import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGroupId, normalizePhoneNumber, normalizeReplyRules, shouldAiReply } from '../../src/domain/ai-reply-rules.mjs';
import { mentionsIdentity } from '../../src/domain/message.mjs';

test('normalizePhoneNumber reduces any typed format to international digits and rejects junk', () => {
  assert.equal(normalizePhoneNumber('+1 (857) 707-5969'), '18577075969');
  assert.equal(normalizePhoneNumber('5511999999999@s.whatsapp.net'), '5511999999999');
  assert.equal(normalizePhoneNumber('12345'), null);
  assert.equal(normalizePhoneNumber('abc'), null);
  assert.equal(normalizePhoneNumber('1'.repeat(16)), null);
});

test('normalizeGroupId accepts a full jid or a bare id, and rejects anything else', () => {
  assert.equal(normalizeGroupId('120363025246125486@g.us'), '120363025246125486@g.us');
  assert.equal(normalizeGroupId(' 120363025246125486 '), '120363025246125486@g.us');
  assert.equal(normalizeGroupId('5511999999999-1600000000'), '5511999999999-1600000000@g.us');
  assert.equal(normalizeGroupId('5511999999999@s.whatsapp.net'), null);
  assert.equal(normalizeGroupId('my group'), null);
});

test('normalizeReplyRules accepts arrays or pasted text, dedupes, and drops invalid entries', () => {
  assert.deepEqual(
    normalizeReplyRules({ numbers: '+1 857 707 5969\n18577075969, nope; +55 11 99999-9999', groups: ['120363025246125486', '120363025246125486@g.us', 'x'] }),
    { numbers: ['18577075969', '5511999999999'], groups: ['120363025246125486@g.us'] },
  );
  assert.deepEqual(normalizeReplyRules(undefined), { numbers: [], groups: [] });
});

test('with no rules the AI replies to nobody, in direct chats or groups', () => {
  assert.equal(shouldAiReply(undefined, { chatId: '5511999999999@s.whatsapp.net', phone: '5511999999999', isGroup: false }), false);
  assert.equal(shouldAiReply({ numbers: [], groups: [] }, { chatId: '1@g.us', isGroup: true, mentionsYou: true }), false);
});

test('a direct chat is answered only when its number is listed, whatever format it was typed in', () => {
  const rules = { numbers: ['+1 (857) 707-5969'], groups: [] };
  assert.equal(shouldAiReply(rules, { chatId: '18577075969@s.whatsapp.net', phone: '18577075969', isGroup: false }), true);
  assert.equal(shouldAiReply(rules, { chatId: '5511999999999@s.whatsapp.net', phone: '5511999999999', isGroup: false }), false);
  assert.equal(shouldAiReply(rules, { chatId: 'x@lid', phone: null, isGroup: false }), false, 'an unresolved sender is never assumed allowed');
});

test('a group is answered only when it is listed AND the account is tagged', () => {
  const rules = { numbers: [], groups: ['120363025246125486@g.us'] };
  const group = '120363025246125486@g.us';
  assert.equal(shouldAiReply(rules, { chatId: group, isGroup: true, mentionsYou: true }), true);
  assert.equal(shouldAiReply(rules, { chatId: group, isGroup: true, mentionsYou: false }), false);
  assert.equal(shouldAiReply(rules, { chatId: '999@g.us', isGroup: true, mentionsYou: true }), false);
});

test('a listed phone number does not open up a group, and a listed group does not open up direct chats', () => {
  assert.equal(shouldAiReply({ numbers: ['5511999999999'], groups: [] }, { chatId: '1@g.us', phone: '5511999999999', isGroup: true, mentionsYou: true }), false);
  assert.equal(shouldAiReply({ numbers: [], groups: ['1@g.us'] }, { chatId: '5511999999999@s.whatsapp.net', phone: '5511999999999', isGroup: false }), false);
});

test('mentionsIdentity ignores the device suffix on the account jid — the real shape of sock.user.id', () => {
  assert.equal(mentionsIdentity(['18577075969@s.whatsapp.net'], '18577075969:12@s.whatsapp.net'), true);
});

test('mentionsIdentity also recognises a tag made with the account LID', () => {
  assert.equal(mentionsIdentity(['2000111222333@lid'], '18577075969:12@s.whatsapp.net', '2000111222333:12@lid'), true);
  assert.equal(mentionsIdentity(['2000111222333@lid'], '18577075969:12@s.whatsapp.net'), false);
  assert.equal(mentionsIdentity(['999@lid'], '18577075969:12@s.whatsapp.net', '2000111222333:12@lid'), false);
});

import { isChatListed, setChatListed } from '../../src/domain/ai-reply-rules.mjs';

test('isChatListed matches a direct chat by phone number and a group by id', () => {
  const rules = { numbers: ['18577075969'], groups: ['120363025246125486@g.us'] };
  assert.equal(isChatListed(rules, { chatId: '18577075969@s.whatsapp.net', phone: '18577075969' }), true);
  assert.equal(isChatListed(rules, { chatId: '5511999999999@s.whatsapp.net', phone: '5511999999999' }), false);
  assert.equal(isChatListed(rules, { chatId: '120363025246125486@g.us' }), true);
  assert.equal(isChatListed(rules, { chatId: '999@g.us' }), false);
  assert.equal(isChatListed(undefined, { chatId: 'x@lid', phone: null }), false);
});

test('setChatListed adds and removes a chat without disturbing the rest, and never duplicates', () => {
  const rules = { numbers: ['18577075969'], groups: [] };
  const added = setChatListed(rules, { chatId: '5511999999999@s.whatsapp.net', phone: '5511999999999' }, true);
  assert.deepEqual(added, { numbers: ['18577075969', '5511999999999'], groups: [] });
  assert.deepEqual(setChatListed(added, { chatId: '5511999999999@s.whatsapp.net', phone: '5511999999999' }, true).numbers, ['18577075969', '5511999999999']);
  assert.deepEqual(setChatListed(added, { chatId: '5511999999999@s.whatsapp.net', phone: '5511999999999' }, false), rules);
  assert.deepEqual(setChatListed(rules, { chatId: '120363025246125486@g.us' }, true).groups, ['120363025246125486@g.us']);
});

test('setChatListed returns null when a direct chat has no known phone number', () => {
  assert.equal(setChatListed({ numbers: [], groups: [] }, { chatId: '2000111222333@lid', phone: null }, true), null);
});
