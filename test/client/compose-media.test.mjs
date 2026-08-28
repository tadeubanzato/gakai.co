import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaKindFromMime, humanFileSize, buildMediaPending } from '../../client/chat-helpers.mjs';

test('mediaKindFromMime maps a mimetype to a player kind', () => {
  assert.equal(mediaKindFromMime('image/png'), 'image');
  assert.equal(mediaKindFromMime('video/mp4'), 'video');
  assert.equal(mediaKindFromMime('audio/ogg; codecs=opus'), 'audio');
  assert.equal(mediaKindFromMime('application/pdf'), 'document');
  assert.equal(mediaKindFromMime(''), 'document');
  assert.equal(mediaKindFromMime(undefined), 'document');
});

test('humanFileSize renders B / KB / MB', () => {
  assert.equal(humanFileSize(512), '512 B');
  assert.equal(humanFileSize(2048), '2 KB');
  assert.equal(humanFileSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(humanFileSize(undefined), '0 B');
});

test('buildMediaPending produces an optimistic bubble that MediaCard can render', () => {
  const file = { name: 'holiday.jpg', type: 'image/jpeg', size: 1234 };
  const pending = buildMediaPending(file, 'at the beach', 'blob:fake-url');

  assert.equal(pending.pending, true);
  assert.equal(pending.fromMe, true);
  assert.equal(pending.hasMedia, true);
  assert.equal(pending.mediaUrl, 'blob:fake-url');
  assert.equal(pending.media.mimetype, 'image/jpeg');
  assert.equal(pending.media.filename, 'holiday.jpg');
  assert.equal(pending.body, 'at the beach');
  assert.equal(pending.text, 'at the beach');
  assert.ok(pending.timestamp > 0);
});

test('buildMediaPending tolerates a file with no name/type and no caption', () => {
  const pending = buildMediaPending({ size: 10 }, '', 'blob:x');
  assert.equal(pending.media.mimetype, 'application/octet-stream');
  assert.equal(pending.media.filename, null);
  assert.equal(pending.body, '');
});
