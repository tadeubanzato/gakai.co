import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { avatarUrl, chatOverview, chatTimestamp, hasMessageContent } from '../../src/domain/message.mjs';

const fixturePath = fileURLToPath(new URL('../fixtures/providers/baileys/chat-overview.json', import.meta.url));

test('chatOverview normalizes a stored chat row into the Gakai view model', async () => {
  const chat = JSON.parse(await readFile(fixturePath, 'utf8'));
  const view = chatOverview(chat);

  assert.equal(view.id, '551199999999@s.whatsapp.net');
  assert.equal(view.name, 'Fixture Contact');
  assert.equal(view.picture, 'https://pps.whatsapp.net/fixture-avatar.jpg');
  assert.equal(view.unreadCount, 3);
  assert.equal(view.timestamp, 1735689600);
  assert.deepEqual(view.lastMessage, { body: 'See you soon', text: 'See you soon', timestamp: 1735689600, hasMedia: false, system: null });
});

test('chatTimestamp falls back through lastMessageTimestamp, conversationTimestamp, then timestamp', () => {
  assert.equal(chatTimestamp({ lastMessageTimestamp: 1735689600 }), 1735689600);
  assert.equal(chatTimestamp({ conversationTimestamp: 1735689600 }), 1735689600);
  assert.equal(chatTimestamp({ timestamp: 1735689600 }), 1735689600);
  // No timestamp anywhere falls through to normalizedTimestamp(0), which
  // Date.parse(0) resolves to 2000-01-01 rather than NaN — a pre-existing
  // quirk of the shared normalizedTimestamp helper, asserted here as the
  // actual (verified) value rather than the value one might expect.
  assert.equal(chatTimestamp({}), 946684800);
});

test('chatOverview defaults unreadCount to 0 when the row omits it', () => {
  const view = chatOverview({ id: 'x@s.whatsapp.net', name: 'No Unread' });
  assert.equal(view.unreadCount, 0);
  assert.equal(view.lastMessage, null);
});

test('avatarUrl returns null for an empty/missing picture', () => {
  assert.equal(avatarUrl(null), null);
  assert.equal(avatarUrl(undefined), null);
  assert.equal(avatarUrl(''), null);
  assert.equal(avatarUrl('   '), null);
});

test('avatarUrl passes a real WhatsApp CDN URL through unchanged', () => {
  assert.equal(avatarUrl('https://pps.whatsapp.net/v/fixture.jpg'), 'https://pps.whatsapp.net/v/fixture.jpg');
});

test('avatarUrl rejects a non-http(s) value', () => {
  assert.equal(avatarUrl('javascript:alert(1)'), null);
  assert.equal(avatarUrl('not a url'), null);
});

test('hasMessageContent rejects a chat with no lastMessage at all', () => {
  assert.equal(hasMessageContent({}), false);
});

test('hasMessageContent accepts a real text message', () => {
  assert.equal(hasMessageContent({ lastMessage: { body: 'hello', text: '', hasMedia: false } }), true);
});

test('hasMessageContent accepts a media-only message with no caption', () => {
  assert.equal(hasMessageContent({ lastMessage: { body: '', text: '', hasMedia: true } }), true);
});

test('hasMessageContent accepts a chat whose latest activity is a real WhatsApp call', () => {
  assert.equal(hasMessageContent({ lastMessage: { body: '', text: '', hasMedia: false, system: { kind: 'call', label: 'Missed voice call' } } }), true);
});

test('hasMessageContent rejects a non-call system event (a metadata touch with no real message)', () => {
  assert.equal(hasMessageContent({ lastMessage: { body: '', text: '', hasMedia: false, system: { kind: 'group-event', label: 'Group activity' } } }), false);
  assert.equal(hasMessageContent({ lastMessage: { body: '', text: '', hasMedia: false, system: null } }), false);
});
