import assert from 'node:assert/strict';
import test from 'node:test';
import { generateWAMessage } from '@whiskeysockets/baileys';
import { quotedForSend } from '../../src/providers/baileys/quote.mjs';

const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
const KEY = 'AAECAwQFBgcICQoLDA0ODw==';
const stored = { key: { remoteJid: '551199999999@s.whatsapp.net', id: 'Q1', fromMe: false }, messageTimestamp: 1, message: { imageMessage: { mimetype: 'image/jpeg', jpegThumbnail: THUMB, mediaKey: KEY, caption: 'c' } } };
const logger = { info() {}, debug() {}, error() {}, warn() {}, trace() {}, child() { return this; } };
const sendWith = quoted => generateWAMessage('551199999999@s.whatsapp.net', { text: 'reply' }, { userJid: '551100000000@s.whatsapp.net', quoted, upload: async () => ({}), logger });
const quotedImage = message => JSON.parse(JSON.stringify(message)).message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;

test('quoting a stored message through quotedForSend keeps its thumbnail and keys intact in the copy Gakai stores', async () => {
  const image = quotedImage(await sendWith(quotedForSend(stored)));
  assert.equal(image.jpegThumbnail, THUMB);
  assert.equal(image.mediaKey, KEY);
});

test('without it, Baileys garbles the stored copy (the bug this guards against)', async () => {
  const image = quotedImage(await sendWith(stored));
  assert.notEqual(image.jpegThumbnail, THUMB);
});

test('nothing to quote stays nothing', () => {
  assert.equal(quotedForSend(null), null);
});
