import assert from 'node:assert/strict';
import test from 'node:test';
import { chatDeleteRange, keysFromDeleteEvent, planMessageDelete } from '../../src/domain/message-delete.mjs';

const chatId = '5511999777057@s.whatsapp.net';

test('your own message is deleted for everyone', () => {
  const key = { remoteJid: chatId, id: 'M1', fromMe: true };
  assert.deepEqual(planMessageDelete({ key, messageTimestamp: 100 }, { chatId, messageId: 'M1' }), { mode: 'revoke', key });
});

test('someone else\'s message is deleted for you, with its time as a plain number — even after a JSON round trip', () => {
  const key = { remoteJid: chatId, id: 'M2', fromMe: false };
  const stored = JSON.parse(JSON.stringify({ key, messageTimestamp: { low: 1759430000, high: 0, unsigned: true } }));
  const plan = planMessageDelete({ ...stored, messageTimestamp: 1759430000 }, { chatId, messageId: 'M2' });
  assert.deepEqual(plan, { mode: 'forMe', key, timestamp: 1759430000 });
  assert.equal(planMessageDelete({ key, messageTimestamp: { toNumber: () => 1759430001 } }, { chatId, messageId: 'M2' }).timestamp, 1759430001);
});

test('a message Gakai has no record of is treated as yours (the only kind a revoke can work on)', () => {
  assert.deepEqual(planMessageDelete(null, { chatId, messageId: 'GONE' }), { mode: 'revoke', key: { remoteJid: chatId, id: 'GONE', fromMe: true } });
});

test('a missing timestamp falls back to now instead of sending zero', () => {
  const key = { remoteJid: chatId, id: 'M3', fromMe: false };
  const plan = planMessageDelete({ key }, { chatId, messageId: 'M3' });
  assert.equal(plan.mode, 'forMe');
  assert.ok(Math.abs(plan.timestamp - Math.floor(Date.now() / 1000)) < 5);
});

test('keysFromDeleteEvent reads specific keys, and ignores a whole-chat clear or junk', () => {
  assert.deepEqual(keysFromDeleteEvent({ keys: [{ remoteJid: chatId, id: 'A', fromMe: false }, { id: 'no-chat' }, null] }), [{ remoteJid: chatId, id: 'A' }]);
  assert.deepEqual(keysFromDeleteEvent({ jid: chatId, all: true }), []);
  assert.deepEqual(keysFromDeleteEvent(undefined), []);
});

test('chatDeleteRange gives Baileys the newest message with a numeric time, or nothing when it cannot', () => {
  const key = { remoteJid: chatId, id: 'L1', fromMe: false };
  assert.deepEqual(chatDeleteRange({ key, messageTimestamp: 1759430000 }), [{ key, messageTimestamp: 1759430000 }]);
  assert.deepEqual(chatDeleteRange({ key, messageTimestamp: { toNumber: () => 1759430002 } }), [{ key, messageTimestamp: 1759430002 }]);
  assert.deepEqual(chatDeleteRange({ key }), []);
  assert.deepEqual(chatDeleteRange(undefined), []);
  assert.deepEqual(chatDeleteRange({ key: { id: 'x' }, messageTimestamp: 5 }), []);
});
