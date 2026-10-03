import assert from 'node:assert/strict';
import test from 'node:test';
import { pictureUrlExpired, freshPictureUrl } from '../../src/providers/baileys/picture.mjs';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const linkExpiringAt = ms => `https://pps.whatsapp.net/v/t61.24694-24/1_2_n.jpg?ccb=11-4&oh=abc&oe=${Math.floor(ms / 1000).toString(16).toUpperCase()}&_nc_sid=5e03e0`;
const DAY = 24 * 60 * 60 * 1000;

test('a picture link past its oe expiry is expired', () => {
  assert.equal(pictureUrlExpired(linkExpiringAt(NOW - 27 * DAY), NOW), true);
  assert.equal(freshPictureUrl(linkExpiringAt(NOW - 27 * DAY), NOW), null);
});

test('a picture link with time left is kept as-is', () => {
  const link = linkExpiringAt(NOW + 10 * DAY);
  assert.equal(pictureUrlExpired(link, NOW), false);
  assert.equal(freshPictureUrl(link, NOW), link);
});

test('a link about to expire is treated as expired, so the browser never gets one that dies in transit', () => {
  assert.equal(pictureUrlExpired(linkExpiringAt(NOW + 10 * 60 * 1000), NOW), true);
});

test('a value with no readable expiry is never judged expired', () => {
  assert.equal(pictureUrlExpired('https://example.com/avatar.jpg', NOW), false);
  assert.equal(pictureUrlExpired('data:image/jpeg;base64,AAAA', NOW), false);
  assert.equal(pictureUrlExpired('not a url', NOW), false);
  assert.equal(freshPictureUrl('https://example.com/avatar.jpg', NOW), 'https://example.com/avatar.jpg');
});

test('a missing picture stays missing', () => {
  assert.equal(pictureUrlExpired(null, NOW), false);
  assert.equal(freshPictureUrl(null, NOW), null);
  assert.equal(freshPictureUrl('', NOW), null);
});
