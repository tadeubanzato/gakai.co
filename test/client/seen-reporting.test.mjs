import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Marking a conversation read depends on ChatPanel reporting what the reader has seen. It once
// vanished in a refactor and nothing read any more, with every other test still green.
const chat = await readFile(new URL('../../client/chat.jsx', import.meta.url), 'utf8');
const app = await readFile(new URL('../../client/app.jsx', import.meta.url), 'utf8');

test('ChatPanel reports the newest seen message only when it is on screen and the chat was opened on purpose', () => {
  const effect = chat.slice(chat.indexOf('onSeen(chatId, newestIncoming)') - 400, chat.indexOf('onSeen(chatId, newestIncoming)') + 200);
  assert.ok(chat.includes('onSeen(chatId, newestIncoming)'), 'the report must exist');
  for (const guard of ['seenHeld', 'loading', 'atBottom', 'windowActive', 'messagesOwnerRef.current !== chatId', 'seenThroughRef.current']) assert.ok(effect.includes(guard), `guarded by ${guard}`);
});

test('the app wires the report to the server and holds it for a chat it opened by itself', () => {
  assert.ok(app.includes('onSeen={handleSeen}'));
  assert.ok(app.includes('seenHeld={autoOpened}') && app.includes('onEngage={engageChat}'));
  assert.ok(/\/read",\{method:"POST",body:JSON\.stringify\(\{through\}\)\}/.test(app), 'posts the read boundary');
});
