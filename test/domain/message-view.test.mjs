import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { messageView, normalizedTimestamp, providerMessageId } from '../../src/domain/message.mjs';

const providerUrl = 'http://provider:3000';
const fixture = name => readFile(fileURLToPath(new URL(`../fixtures/providers/waha/${name}`, import.meta.url)), 'utf8').then(JSON.parse);

test('messageView extracts the serialized id from a structured WAHA id object', async () => {
  const message = await fixture('message-text.json');
  const view = messageView(message, providerUrl);

  assert.equal(view.id, 'false_551199999999@c.us_3EB0FIXTURE1');
  assert.notEqual(view.id, '[object Object]');
  assert.equal(view.body, 'Hello from fixture');
  assert.equal(view.fromMe, false);
  assert.equal(view.timestamp, 1735689600);
});

test('messageView normalizes a quoted/reply message into replyTo', async () => {
  const message = await fixture('message-reply.json');
  const view = messageView(message, providerUrl);

  assert.equal(view.fromMe, true);
  assert.deepEqual(view.replyTo, {
    id: 'false_551199999999@c.us_3EB0FIXTURE1',
    body: 'Hello from fixture',
    hasMedia: false,
    participant: null,
  });
});

test('messageView shapes a link-preview message from provider _data.links', async () => {
  const message = await fixture('message-linkpreview.json');
  const view = messageView(message, providerUrl);

  assert.ok(view.linkPreview);
  assert.equal(view.linkPreview.url, 'https://example.com/article');
  assert.equal(view.linkPreview.title, 'Example Article');
  assert.equal(view.linkPreview.description, 'A sanitized example description.');
  assert.equal(view.linkPreview.image, 'https://example.com/thumb.jpg');
});

test('providerMessageId never returns the "[object Object]" collision string', () => {
  assert.equal(providerMessageId({ _serialized: 'abc' }), 'abc');
  assert.equal(providerMessageId({ id: 'plain-id' }), 'plain-id');
  assert.equal(providerMessageId('already-a-string'), 'already-a-string');
  assert.equal(providerMessageId({}), null);
  assert.equal(providerMessageId(null), null);
});

test('normalizedTimestamp treats large numbers as milliseconds and small numbers as seconds', () => {
  assert.equal(normalizedTimestamp(1735689600000), 1735689600);
  assert.equal(normalizedTimestamp(1735689600), 1735689600);
  assert.equal(normalizedTimestamp('2025-01-01T00:00:00Z'), Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000));
  assert.equal(normalizedTimestamp('not a date'), 0);
});
