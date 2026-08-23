import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHtmlEntities } from '../../src/lib/html.mjs';

test('decodeHtmlEntities decodes &amp; back to a real & — the actual reported bug', () => {
  // Verified directly against Instagram's CDN: a URL with this exact pattern
  // (signed query params joined by literal "&amp;" instead of "&") gets a
  // 403; the decoded version loads the real image.
  const mangled = 'https://scontent.cdninstagram.com/img.jpg?a=1&amp;b=2&amp;oh=abc&amp;oe=def';
  assert.equal(decodeHtmlEntities(mangled), 'https://scontent.cdninstagram.com/img.jpg?a=1&b=2&oh=abc&oe=def');
});

test('decodeHtmlEntities decodes quot/apos/lt/gt named entities', () => {
  assert.equal(decodeHtmlEntities('&quot;hello&quot;'), '"hello"');
  assert.equal(decodeHtmlEntities('it&apos;s'), "it's");
  assert.equal(decodeHtmlEntities('a &lt; b &gt; c'), 'a < b > c');
});

test('decodeHtmlEntities decodes numeric and hex entities', () => {
  assert.equal(decodeHtmlEntities('&#39;quoted&#39;'), "'quoted'");
  assert.equal(decodeHtmlEntities('&#x27;quoted&#x27;'), "'quoted'");
});

test('decodeHtmlEntities leaves plain text with no entities unchanged', () => {
  assert.equal(decodeHtmlEntities('nothing to decode here'), 'nothing to decode here');
});

test('decodeHtmlEntities handles null/undefined input safely', () => {
  assert.equal(decodeHtmlEntities(null), '');
  assert.equal(decodeHtmlEntities(undefined), '');
});
