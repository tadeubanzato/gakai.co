import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractMentionIds, mentionsIdentity, messageView, normalizedTimestamp, resolveMentionLabels } from '../../src/domain/message.mjs';

const ctx = { accountId: 'account-fixture', chatId: '551199999999@s.whatsapp.net' };
const fixture = name => readFile(fileURLToPath(new URL(`../fixtures/providers/baileys/${name}`, import.meta.url)), 'utf8').then(JSON.parse);

test('messageView reads the id straight off key.id — no structured-object collision to guard against', async () => {
  const message = await fixture('message-text.json');
  const view = messageView(message, ctx);

  assert.equal(view.id, '3EB0FIXTURE1');
  assert.equal(view.body, 'Hello from fixture');
  assert.equal(view.fromMe, false);
  assert.equal(view.timestamp, 1735689600);
  assert.equal(view.sender.name, 'Fixture Contact');
});

test('messageView normalizes a quoted/reply message into replyTo', async () => {
  const message = await fixture('message-reply.json');
  const view = messageView(message, ctx);

  assert.equal(view.fromMe, true);
  assert.deepEqual(view.replyTo, {
    id: '3EB0FIXTURE1',
    body: 'Hello from fixture',
    hasMedia: false,
    participant: null,
  });
});

test('messageView shapes a link-preview message from Baileys\' own extendedTextMessage fields', async () => {
  const message = await fixture('message-linkpreview.json');
  const view = messageView(message, ctx);

  assert.ok(view.linkPreview);
  assert.equal(view.linkPreview.url, 'https://example.com/article');
  assert.equal(view.linkPreview.title, 'Example Article');
  assert.equal(view.linkPreview.description, 'A sanitized example description.');
  // No jpegThumbnail in the fixture — image legitimately stays null even
  // though title/description are present.
  assert.equal(view.linkPreview.image, null);
});

test('normalizedTimestamp treats large numbers as milliseconds and small numbers as seconds', () => {
  assert.equal(normalizedTimestamp(1735689600000), 1735689600);
  assert.equal(normalizedTimestamp(1735689600), 1735689600);
  assert.equal(normalizedTimestamp('2025-01-01T00:00:00Z'), Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000));
  assert.equal(normalizedTimestamp('not a date'), 0);
});

test('normalizedTimestamp unwraps a protobuf Long-like value via toNumber()', () => {
  assert.equal(normalizedTimestamp({ toNumber: () => 1735689600 }), 1735689600);
});

test('messageView routes message media through Gakai\'s own on-demand media endpoint, never a raw provider URL', async () => {
  const message = await fixture('message-media.json');
  const view = messageView(message, ctx);

  assert.equal(view.media.url, `/api/app/media?accountId=account-fixture&chatId=${encodeURIComponent(ctx.chatId)}&messageId=3EB0FIXTURE4`);
  assert.equal(view.media.mimetype, 'image/jpeg');
  assert.equal(view.body, 'A fixture photo');
  assert.equal(view.hasMedia, true);
});

test('messageView leaves media null for a plain text message', async () => {
  const message = await fixture('message-text.json');
  const view = messageView(message, ctx);
  assert.equal(view.media, null);
  assert.equal(view.mediaUrl, null);
  assert.equal(view.hasMedia, false);
});

test('messageView derives a stable, deterministic id when the message has no key.id', async () => {
  const message = await fixture('message-no-id.json');
  const first = messageView(message, ctx);
  const second = messageView(message, ctx);

  assert.ok(first.id.startsWith('derived_'));
  assert.equal(first.id, second.id, 'the same input must always produce the same id, unlike a per-render array-index fallback');
});

test('messageView derives different ids for messages that differ in timestamp or body', async () => {
  const base = await fixture('message-no-id.json');
  const differentTimestamp = messageView({ ...base, messageTimestamp: base.messageTimestamp + 1 }, ctx);
  const differentBody = messageView({ ...base, message: { conversation: 'a different body' } }, ctx);
  const original = messageView(base, ctx);

  assert.notEqual(differentTimestamp.id, original.id);
  assert.notEqual(differentBody.id, original.id);
});

test('extractMentionIds finds mentions in both the main body and a quoted reply body', () => {
  const ids = extractMentionIds('Valeu @89249571455071 !', 'Pensei que vc ia curtir, Ze.');
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

test('messageView surfaces the raw mentioned-JID list for the caller to resolve, rather than resolving it itself', async () => {
  const message = {
    key: { remoteJid: ctx.chatId, fromMe: false, id: 'mention-fixture' },
    messageTimestamp: 1735689960,
    message: {
      extendedTextMessage: {
        text: 'Valeu @89249571455071 !',
        contextInfo: { mentionedJid: ['89249571455071@s.whatsapp.net'] },
      },
    },
  };
  const view = messageView(message, ctx);
  assert.deepEqual(view.mentionedJids, ['89249571455071@s.whatsapp.net']);
  // messageView itself doesn't resolve mentions (that needs a contact
  // lookup only server.mjs's enrichMessage can do) — the raw @<id> survives
  // unresolved through to this point.
  assert.equal(view.body, 'Valeu @89249571455071 !');
});

test('mentionsIdentity matches an exact jid and a same-number jid on a different domain', () => {
  assert.equal(mentionsIdentity(['5511999999999@s.whatsapp.net'], '5511999999999@s.whatsapp.net'), true);
  assert.equal(mentionsIdentity(['5511999999999@lid'], '5511999999999@s.whatsapp.net'), true, 'the account\'s own identity can be reported as either @s.whatsapp.net or @lid');
  assert.equal(mentionsIdentity(['5511999999999@s.whatsapp.net'], '5511999999999@lid'), true);
});

test('mentionsIdentity is false when the mention list is empty, missing the account, or ownJid is unknown', () => {
  assert.equal(mentionsIdentity([], '5511999999999@s.whatsapp.net'), false);
  assert.equal(mentionsIdentity(['5511000000000@s.whatsapp.net'], '5511999999999@s.whatsapp.net'), false);
  assert.equal(mentionsIdentity(['5511999999999@s.whatsapp.net'], ''), false, 'an unresolved own identity must never be treated as a match');
  assert.equal(mentionsIdentity(undefined, '5511999999999@s.whatsapp.net'), false);
});

test('messageView maps a missed-call stub message to a system "call" view', () => {
  const message = { key: { remoteJid: ctx.chatId, fromMe: false, id: 'call-fixture' }, messageTimestamp: 1735690000, messageStubType: 41 /* CALL_MISSED_VIDEO */ };
  const view = messageView(message, ctx);
  assert.equal(view.system.kind, 'call');
  assert.match(view.system.label, /video/i);
});
