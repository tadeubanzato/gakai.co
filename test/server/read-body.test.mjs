import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// server.mjs runs top-level setup (data dir, sqlite, server.listen) on import,
// so environment must be set before the dynamic import runs.
const scratch = await mkdtemp(join(tmpdir(), 'gakai-readbody-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server, readBody } = await import('../../server.mjs');
after(() => server.close());

test('readBody preserves a multi-byte UTF-8 character split across a chunk boundary', async () => {
  const body = JSON.stringify({ text: 'hi \u{1F600} bye' }); // grinning face emoji, 4-byte UTF-8
  const bytes = Buffer.from(body, 'utf8');
  const emojiStart = bytes.indexOf(Buffer.from('\u{1F600}', 'utf8'));
  assert.ok(emojiStart > 0, 'fixture body must contain the emoji to split');
  const splitAt = emojiStart + 2; // land the split inside the 4-byte sequence

  const chunks = [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
  const fakeReq = { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };

  const parsed = await readBody(fakeReq);

  assert.equal(parsed.text, 'hi \u{1F600} bye');
  assert.equal(fakeReq.rawBody, body);
});

test('readBody rejects a body over the 1MB limit', async () => {
  const oversized = Buffer.alloc(1024 * 1024 + 1, 'a');
  const fakeReq = { async *[Symbol.asyncIterator]() { yield oversized; } };

  await assert.rejects(readBody(fakeReq), error => error.status === 413);
});
