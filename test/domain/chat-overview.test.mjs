import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { avatarUrl, chatOverview, chatTimestamp, hasMessageContent } from '../../src/domain/message.mjs';

const fixturePath = fileURLToPath(new URL('../fixtures/providers/waha/chat-overview.json', import.meta.url));
const providerUrl = 'http://provider:3000';

test('chatOverview normalizes a WAHA chat overview item into the Gakai view model', async () => {
  const chat = JSON.parse(await readFile(fixturePath, 'utf8'));
  const view = chatOverview(chat, providerUrl);

  assert.equal(view.id, '551199999999@c.us');
  assert.equal(view.name, 'Fixture Contact');
  assert.equal(view.unreadCount, 3);
  assert.equal(view.timestamp, 1735689600);
  assert.deepEqual(view.lastMessage, { body: 'See you soon', text: 'See you soon', timestamp: 1735689600, hasMedia: false, system: null });
});

test('chatOverview routes a provider-relative picture through the Gakai media proxy', async () => {
  const chat = JSON.parse(await readFile(fixturePath, 'utf8'));
  const view = chatOverview(chat, providerUrl);

  assert.equal(view.picture, '/api/app/media?path=%2Fapi%2Ffiles%2Ffixture-avatar.jpg');
});

test('chatTimestamp falls back through nested provider timestamp shapes', () => {
  assert.equal(chatTimestamp({ lastMessage: { timestamp: 1735689600 } }), 1735689600);
  assert.equal(chatTimestamp({ _chat: { lastMessage: { _data: { timestamp: 1735689600 } } } }), 1735689600);
  // No timestamp anywhere falls through to normalizedTimestamp(0), which legacy
  // Date.parse(0) resolves to 2000-01-01 rather than NaN. Pre-existing quirk in
  // the lifted function, not something this stage changes — asserting the
  // actual (verified) value rather than the value one might expect.
  assert.equal(chatTimestamp({}), 946684800);
});

test('chatOverview defaults unreadCount to 0 when the provider omits it', () => {
  const view = chatOverview({ id: 'x@c.us', name: 'No Unread' }, providerUrl);
  assert.equal(view.unreadCount, 0);
  assert.equal(view.lastMessage, null);
});

test('avatarUrl returns null for an empty/missing picture instead of resolving to providerUrl itself', () => {
  // `new URL('', providerUrl)` resolves to providerUrl, not an error — without
  // an explicit empty check that internal Docker-only address leaked out as a
  // "picture", which both looked like a real (broken) image to the browser
  // and, worse, suppressed the real per-chat picture lookup that only runs
  // when the chatOverview picture comes back falsy.
  assert.equal(avatarUrl(null, providerUrl), null);
  assert.equal(avatarUrl(undefined, providerUrl), null);
  assert.equal(avatarUrl('', providerUrl), null);
  assert.equal(avatarUrl('   ', providerUrl), null);
});

test('chatOverview leaves picture null (not providerUrl) when the provider gives no picture, so the caller\'s fallback lookup still runs', () => {
  const view = chatOverview({ id: 'jose@lid', name: 'Jose Oliveira', picture: null }, providerUrl);
  assert.equal(view.picture, null);
});

test('hasMessageContent rejects a fresh timestamp with no real message behind it', () => {
  // Observed live: WAHA/WEBJS can bump lastMessage.timestamp to "now" during a
  // background resync with body, text, and hasMedia all empty/false — no real
  // message was sent. That must not count as recent activity.
  assert.equal(hasMessageContent({ lastMessage: { timestamp: 1787438229, body: '', text: '', hasMedia: false } }), false);
});

test('hasMessageContent accepts a real text message', () => {
  assert.equal(hasMessageContent({ lastMessage: { body: 'hello', text: '', hasMedia: false } }), true);
});

test('hasMessageContent accepts a media-only message with no caption', () => {
  assert.equal(hasMessageContent({ lastMessage: { body: '', text: '', hasMedia: true } }), true);
});

test('hasMessageContent is false when there is no lastMessage at all', () => {
  assert.equal(hasMessageContent({}), false);
});

test('hasMessageContent accepts a chat whose latest activity is a real WhatsApp call', () => {
  // A voice/video call has no body/text/media but is a genuine, distinguishing
  // event (real _data.type) — unlike the untyped resync touch above, this must
  // keep the conversation in the inbox instead of silently dropping it.
  assert.equal(hasMessageContent({ lastMessage: { body: '', text: '', hasMedia: false, _data: { type: 'call_log', isVideoCall: false } } }), true);
});

test('hasMessageContent rejects non-call system events, even though they carry a real type', () => {
  // Observed live: WAHA can bulk-touch several unrelated chats' timestamps
  // during a background resync, including ones with zero actual message
  // history — an encryption-handshake notice (e2e_notification), a group
  // notification, or the generic system fallback is administrative noise
  // WAHA can generate on its own with no real communication behind it at
  // all. Only an actual call (systemMessageView().kind === 'call') is
  // trustworthy enough to count as real activity.
  assert.equal(hasMessageContent({ lastMessage: { body: '', text: '', hasMedia: false, _data: { type: 'e2e_notification', subtype: 'encrypt' } } }), false);
  assert.equal(hasMessageContent({ lastMessage: { body: '', text: '', hasMedia: false, _data: { type: 'gp2' } } }), false);
  assert.equal(hasMessageContent({ lastMessage: { body: '', text: '', hasMedia: false, _data: { type: 'notification_template', subtype: 'change_username' } } }), false);
});

test('chatOverview surfaces a system label for a call-only conversation so the inbox preview is not blank', () => {
  const view = chatOverview({ id: 'x@c.us', name: 'Call Only', lastMessage: { body: '', text: '', timestamp: 1735689600, hasMedia: false, _data: { type: 'call_log', isVideoCall: false } } }, providerUrl);
  assert.equal(view.lastMessage.system.kind, 'call');
});
