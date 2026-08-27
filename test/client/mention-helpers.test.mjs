import assert from 'node:assert/strict';
import test from 'node:test';
import { mentionQueryAt, applyMentionPick, buildMentionPayload } from '../../client/chat-helpers.mjs';

test('mentionQueryAt reports the partial name while the caret sits in an "@…" run', () => {
  assert.equal(mentionQueryAt('hey @an', 7), 'an');
  assert.equal(mentionQueryAt('@an', 3), 'an');
  assert.equal(mentionQueryAt('hey @', 5), '');
});

test('mentionQueryAt returns null when the caret is not in a mention', () => {
  assert.equal(mentionQueryAt('hey there', 9), null);
  assert.equal(mentionQueryAt('hey @ana ', 9), null); // whitespace closed the run
  assert.equal(mentionQueryAt('mail@example', 12), null); // no leading space before @
});

test('applyMentionPick swaps the active fragment for "@Name " and reports the caret', () => {
  const result = applyMentionPick('hey @an', 7, 'Ana Lima');
  assert.equal(result.text, 'hey @Ana Lima ');
  assert.equal(result.caret, 'hey @Ana Lima '.length);
});

test('applyMentionPick keeps trailing text and collapses a duplicated space', () => {
  const result = applyMentionPick('hey @an there', 7, 'Ana');
  assert.equal(result.text, 'hey @Ana there');
});

test('applyMentionPick returns null when the caret is not in a mention fragment', () => {
  assert.equal(applyMentionPick('hey there', 9, 'Ana'), null);
});

test('buildMentionPayload rewrites each picked "@Name" to "@<number>" and collects the jids', () => {
  const picks = [
    { jid: '55119@s.whatsapp.net', name: 'Ana Lima', number: '55119' },
    { jid: '55128@s.whatsapp.net', name: 'Bruno', number: '55128' },
  ];
  const { text, mentions } = buildMentionPayload('cc @Ana Lima and @Bruno', picks);
  assert.equal(text, 'cc @55119 and @55128');
  assert.deepEqual(mentions, ['55119@s.whatsapp.net', '55128@s.whatsapp.net']);
});

test('buildMentionPayload drops a pick whose "@Name" the reader edited back out', () => {
  const picks = [{ jid: '55119@s.whatsapp.net', name: 'Ana Lima', number: '55119' }];
  const { text, mentions } = buildMentionPayload('never mind', picks);
  assert.equal(text, 'never mind');
  assert.deepEqual(mentions, []);
});

test('buildMentionPayload is a no-op with no picks', () => {
  const { text, mentions } = buildMentionPayload('plain @55119 text', []);
  assert.equal(text, 'plain @55119 text');
  assert.deepEqual(mentions, []);
});
