import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractMentionIds, mentionsIdentity, messageView, normalizedTimestamp, resolveMentionLabels, bareJidUser, isGroupChatId, isLidJid, isSameIdentity, ackStatusName, ackStatusRank } from '../../src/domain/message.mjs';

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

test('messageView wraps an already-base64 jpegThumbnail string without re-encoding it', async () => {
  // Baileys delivers extendedTextMessage.jpegThumbnail as a plain base64
  // string here (confirmed against real stored message payloads), not a
  // Buffer/Uint8Array. Treating it as raw bytes (Buffer.from(string)
  // defaults to utf8) re-encodes the base64 text itself into a second
  // layer of base64 — a data URI the browser can never decode. The fixed
  // image field must be exactly the fixture's base64 wrapped in the data
  // URI prefix, not a re-encoded version of it.
  const message = await fixture('message-linkpreview-thumbnail.json');
  const view = messageView(message, ctx);
  const thumbnailBase64 = message.message.extendedTextMessage.jpegThumbnail;

  assert.equal(view.linkPreview.image, `data:image/jpeg;base64,${thumbnailBase64}`);
  // And that base64 payload must decode to real JPEG bytes on the first
  // pass — not to more base64 text (the double-encoding failure mode).
  const decoded = Buffer.from(thumbnailBase64, 'base64');
  assert.deepEqual(decoded.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
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

test('bareJidUser strips any JID domain via Baileys\' own decoder, not a hand-rolled suffix pattern', () => {
  assert.equal(bareJidUser('5511999999999@s.whatsapp.net'), '5511999999999');
  assert.equal(bareJidUser('120363000000000000@g.us'), '120363000000000000');
  assert.equal(bareJidUser('123456789012345@lid'), '123456789012345');
  assert.equal(bareJidUser('5511999999999:2@s.whatsapp.net'), '5511999999999', 'a device suffix must not leak into the bare user');
  assert.equal(bareJidUser(''), '', 'an empty/missing jid must not throw');
});

test('isGroupChatId classifies group JIDs and rejects everything else', () => {
  assert.equal(isGroupChatId('120363000000000000@g.us'), true);
  assert.equal(isGroupChatId('5511999999999@s.whatsapp.net'), false);
  assert.equal(isGroupChatId(''), false);
});

test('isLidJid classifies @lid JIDs and rejects everything else', () => {
  assert.equal(isLidJid('123456789012345@lid'), true);
  assert.equal(isLidJid('5511999999999@s.whatsapp.net'), false);
  assert.equal(isLidJid(''), false);
});

test('isSameIdentity matches the same user across a device suffix, and rejects an unrelated identity', () => {
  assert.equal(isSameIdentity('5511999999999@s.whatsapp.net', '5511999999999@s.whatsapp.net'), true);
  assert.equal(isSameIdentity('5511999999999:2@s.whatsapp.net', '5511999999999@s.whatsapp.net'), true, 'a device suffix must not break the match — this is exactly what areJidsSameUser exists for');
  // A LID is an opaque identifier, not the phone number itself — with a
  // genuinely unrelated digit string (the realistic case), a LID and a
  // phone number correctly do not match.
  assert.equal(isSameIdentity('123456789012345@lid', '5511999999999@s.whatsapp.net'), false);
  assert.equal(isSameIdentity('', '5511999999999@s.whatsapp.net'), false);
  assert.equal(isSameIdentity('5511999999999@s.whatsapp.net', ''), false);
});

test('messageView maps a missed-call stub message to a system "call" view', () => {
  const message = { key: { remoteJid: ctx.chatId, fromMe: false, id: 'call-fixture' }, messageTimestamp: 1735690000, messageStubType: 41 /* CALL_MISSED_VIDEO */ };
  const view = messageView(message, ctx);
  assert.equal(view.system.kind, 'call');
  assert.match(view.system.label, /video/i);
});

test('messageView normalizes a shared location into a location card view', async () => {
  const view = messageView(await fixture('message-location.json'), ctx);
  assert.equal(view.location.latitude, -23.56312);
  assert.equal(view.location.longitude, -46.65403);
  assert.equal(view.location.name, 'Parque Ibirapuera');
  assert.equal(view.location.live, false);
  assert.match(view.body, /Parque Ibirapuera/); // inbox preview text, not blank
});

test('messageView normalizes a shared contact, pulling the phone from the vCard waid', async () => {
  const view = messageView(await fixture('message-contact.json'), ctx);
  assert.deepEqual(view.contacts, [{ name: 'Sample Person', phone: '15550001234' }]);
  assert.match(view.body, /Sample Person/);
});

test('messageView falls back to the vCard TEL when there is no waid', () => {
  const view = messageView({
    key: { remoteJid: ctx.chatId, fromMe: false, id: 'c2' }, messageTimestamp: 1735689710,
    message: { contactMessage: { displayName: 'No Waid', vcard: 'BEGIN:VCARD\nFN:No Waid\nTEL:+1 555 777 8888\nEND:VCARD' } },
  }, ctx);
  assert.deepEqual(view.contacts, [{ name: 'No Waid', phone: '+15557778888' }]);
});

test('messageView normalizes a poll into a question + options list', async () => {
  const view = messageView(await fixture('message-poll.json'), ctx);
  assert.equal(view.poll.question, 'Where should we eat?');
  assert.deepEqual(view.poll.options, ['Pizza', 'Sushi', 'Salad']);
  assert.equal(view.poll.multiple, false);
});

test('messageView unwraps a view-once photo and flags it', async () => {
  const view = messageView(await fixture('message-viewonce-image.json'), ctx);
  assert.equal(view.viewOnce, true);
  assert.equal(view.hasMedia, true, 'still routed through the media path');
  assert.equal(view.body, 'one-time photo');
  assert.equal(view.location, null);
  assert.equal(view.poll, null);
});

test('ackStatusName normalizes the numeric WhatsApp status enum to a stable name', () => {
  assert.equal(ackStatusName(2), 'SERVER_ACK');
  assert.equal(ackStatusName(3), 'DELIVERY_ACK');
  assert.equal(ackStatusName(4), 'READ');
  assert.equal(ackStatusName(5), 'PLAYED');
  assert.equal(ackStatusName('READ'), 'READ', 'an already-named status passes through');
  assert.equal(ackStatusName('3'), 'DELIVERY_ACK', 'a numeric string is still mapped');
  assert.equal(ackStatusName(null), null);
  assert.equal(ackStatusName(''), null);
  assert.equal(ackStatusName('nonsense'), null);
});

test('ackStatusRank orders statuses so a late update can never downgrade a tick', () => {
  assert.ok(ackStatusRank(4) > ackStatusRank(3));
  assert.ok(ackStatusRank(3) > ackStatusRank(2));
  assert.ok(ackStatusRank('READ') > ackStatusRank('SERVER_ACK'));
  assert.equal(ackStatusRank(null), -1);
  assert.equal(ackStatusRank('nonsense'), -1);
});

test('messageView surfaces a sent message\'s delivery status as ackName', () => {
  const delivered = messageView({ key: { remoteJid: ctx.chatId, fromMe: true, id: 'sent-1' }, messageTimestamp: 1735690000, status: 3, message: { conversation: 'hi' } }, ctx);
  assert.equal(delivered.ackName, 'DELIVERY_ACK');
  const read = messageView({ key: { remoteJid: ctx.chatId, fromMe: true, id: 'sent-2' }, messageTimestamp: 1735690000, status: 4, message: { conversation: 'hi' } }, ctx);
  assert.equal(read.ackName, 'READ');
  const noStatus = messageView({ key: { remoteJid: ctx.chatId, fromMe: true, id: 'sent-3' }, messageTimestamp: 1735690000, message: { conversation: 'hi' } }, ctx);
  assert.equal(noStatus.ackName, null);
});
