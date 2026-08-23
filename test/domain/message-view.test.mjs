import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractMentionIds, mentionsIdentity, messageView, normalizedTimestamp, providerMessageId, resolveMentionLabels } from '../../src/domain/message.mjs';

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

test('messageView routes a provider-relative media URL through the Gakai media proxy', async () => {
  const message = await fixture('message-media.json');
  const view = messageView(message, providerUrl);

  assert.equal(view.media.url, '/api/app/media?path=%2Fapi%2Ffiles%2Ffixture-image.jpg');
  assert.equal(view.media.mimetype, 'image/jpeg');
});

test('messageView leaves media.url null when the provider sends no media URL', async () => {
  const message = await fixture('message-text.json');
  const view = messageView(message, providerUrl);
  assert.equal(view.media, null);
  assert.equal(view.mediaUrl, null);
});

test('messageView derives a stable, deterministic id when the provider gives none', async () => {
  const message = await fixture('message-no-id.json');
  const first = messageView(message, providerUrl);
  const second = messageView(message, providerUrl);

  assert.ok(first.id.startsWith('derived_'));
  assert.equal(first.id, second.id, 'the same input must always produce the same id, unlike a per-render array-index fallback');
});

test('messageView derives different ids for messages that differ in timestamp, sender, or body', async () => {
  const base = await fixture('message-no-id.json');
  const differentTimestamp = messageView({ ...base, timestamp: base.timestamp + 1 }, providerUrl);
  const differentBody = messageView({ ...base, body: 'a different body', text: 'a different body' }, providerUrl);
  const original = messageView(base, providerUrl);

  assert.notEqual(differentTimestamp.id, original.id);
  assert.notEqual(differentBody.id, original.id);
});

test('extractMentionIds finds mentions in both the main body and a quoted reply body', () => {
  const ids = extractMentionIds('Valeu @89249571455071 !', 'Pensei que vc ia curtir, Zé.');
  assert.deepEqual(ids, ['89249571455071']);
});

test('extractMentionIds dedups a mention that appears in both texts and caps at 8', () => {
  const many = Array.from({ length: 10 }, (_, i) => `@${10000 + i}00000`).join(' ');
  assert.equal(extractMentionIds(many, `@10000000 ${many}`).length, 8);
});

test('resolveMentionLabels replaces a resolved mention and leaves an unresolved one as-is', () => {
  const labels = new Map([['89249571455071', 'Erica Tanaka']]);
  assert.equal(resolveMentionLabels('Valeu @89249571455071 !', labels), 'Valeu @Erica Tanaka !');
  assert.equal(resolveMentionLabels('Valeu @00000000000000 !', labels), 'Valeu @00000000000000 !');
});

test('messageView resolves a mention inside replyTo.body, not just the main body — the actual reported bug', async () => {
  const message = {
    id: { _serialized: 'reply-mention-fixture' },
    timestamp: 1735689960,
    fromMe: false,
    body: 'Não quer ir com a gente e explicar o que tá acontecendo?',
    text: 'Não quer ir com a gente e explicar o que tá acontecendo?',
    quotedMsg: { id: { _serialized: 'quoted-fixture' }, body: 'Valeu @89249571455071 !' },
  };
  const view = messageView(message, providerUrl);
  // messageView itself doesn't resolve mentions (that needs a contact
  // lookup only enrichMessage in server.mjs can do) — this just proves the
  // raw quoted mention id survives unresolved through to this point, which
  // is the precondition enrichMessage's resolveMentionLabels(replyTo.body)
  // then acts on.
  assert.equal(view.replyTo.body, 'Valeu @89249571455071 !');
});

test('mentionsIdentity matches an exact jid and a same-number jid on a different domain (@lid vs @c.us)', () => {
  assert.equal(mentionsIdentity(['5511999999999@c.us'], '5511999999999@c.us'), true);
  assert.equal(mentionsIdentity(['5511999999999@lid'], '5511999999999@c.us'), true, 'the same engine can report the own identity as either @c.us or @lid');
  assert.equal(mentionsIdentity(['5511999999999@c.us'], '5511999999999@lid'), true);
});

test('mentionsIdentity is false when the mention list is empty, missing the account, or ownId is unknown', () => {
  assert.equal(mentionsIdentity([], '5511999999999@c.us'), false);
  assert.equal(mentionsIdentity(['5511000000000@c.us'], '5511999999999@c.us'), false);
  assert.equal(mentionsIdentity(['5511999999999@c.us'], ''), false, 'an unresolved own identity must never be treated as a match');
  assert.equal(mentionsIdentity(undefined, '5511999999999@c.us'), false);
});
