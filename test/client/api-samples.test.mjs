import assert from 'node:assert/strict';
import test from 'node:test';
import { curlSample, jsonSample, SEND_PATH, TOKEN_PLACEHOLDER } from '../../client/api-samples.mjs';

test('the JSON sample is valid JSON with a phone number and a text', () => {
  const parsed = JSON.parse(jsonSample());
  assert.deepEqual(Object.keys(parsed), ['phone', 'text']);
  assert.match(parsed.phone, /^\d{6,15}$/);
  assert.ok(parsed.text.length > 0);
});

test('the curl sample is a complete command for this server, using the placeholder by default', () => {
  const curl = curlSample('https://gakai.example.com');
  assert.match(curl, /^curl -X POST https:\/\/gakai\.example\.com\/api\/integrations\/v1\/messages \\\n/);
  assert.ok(curl.includes(`Authorization: Bearer ${TOKEN_PLACEHOLDER}`));
  assert.ok(curl.includes('Content-Type: application/json'));
  assert.ok(SEND_PATH.startsWith('/api/integrations/v1/'));
});

test('the curl sample carries a real token when given one, and its body is the same JSON', () => {
  const curl = curlSample('http://localhost:3000', 'wh_live_abc123');
  assert.ok(curl.includes('Authorization: Bearer wh_live_abc123'));
  assert.equal(curl.includes(TOKEN_PLACEHOLDER), false);
  const bodyText = curl.match(/-d '(.*)'$/s)[1];
  assert.deepEqual(JSON.parse(bodyText), JSON.parse(jsonSample()));
});
