import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chatOverview, chatTimestamp } from '../../src/domain/message.mjs';

const fixturePath = fileURLToPath(new URL('../fixtures/providers/waha/chat-overview.json', import.meta.url));
const providerUrl = 'http://provider:3000';

test('chatOverview normalizes a WAHA chat overview item into the Gakai view model', async () => {
  const chat = JSON.parse(await readFile(fixturePath, 'utf8'));
  const view = chatOverview(chat, providerUrl);

  assert.equal(view.id, '551199999999@c.us');
  assert.equal(view.name, 'Fixture Contact');
  assert.equal(view.unreadCount, 3);
  assert.equal(view.timestamp, 1735689600);
  assert.deepEqual(view.lastMessage, { body: 'See you soon', text: 'See you soon', timestamp: 1735689600, hasMedia: false });
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
