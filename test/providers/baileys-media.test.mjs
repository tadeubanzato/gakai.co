import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaStore } from '../../src/providers/baileys/media.mjs';

async function withStore(options, run) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gakai-media-'));
  try { await run(createMediaStore({ cacheDir, ...options }), cacheDir); }
  finally { await rm(cacheDir, { recursive: true, force: true }); }
}
const never = () => new Promise(() => {});
const sock = { updateMediaMessage: never };
const message = { key: { id: 'm1' } };

test('a download that never settles is failed by the timeout instead of hanging the request', async () => {
  await withStore({ downloadImpl: never, downloadTimeoutMs: 30 }, async store => {
    await assert.rejects(store.download('acct', 'm1', message, sock, 'image/jpeg'), error => error.status === 504 && /timed out/.test(error.message));
  });
});

test('a phone that never answers the re-upload request is given up on', async () => {
  // Mirrors Baileys: an expired link makes it call ctx.reuploadRequest and await the result.
  const downloadImpl = (waMessage, type, options, ctx) => ctx.reuploadRequest(waMessage);
  await withStore({ downloadImpl, reuploadTimeoutMs: 30, downloadTimeoutMs: 5000 }, async store => {
    await assert.rejects(store.download('acct', 'm1', message, sock, 'image/jpeg'), error => error.status === 504 && /re-upload/.test(error.message));
  });
});

test('a failed attachment is not downloaded again straight away', async () => {
  let calls = 0;
  const downloadImpl = async () => { calls++; throw new Error('gone'); };
  await withStore({ downloadImpl }, async store => {
    await assert.rejects(store.download('acct', 'm1', message, sock, 'image/jpeg'), /gone/);
    await assert.rejects(store.download('acct', 'm1', message, sock, 'image/jpeg'), /gone/);
    assert.equal(calls, 1);
  });
});

test('the failure is forgotten after its window, so the attachment can be retried', async () => {
  let calls = 0;
  const downloadImpl = async () => { if (calls++ === 0) throw new Error('gone'); return Buffer.from('ok'); };
  await withStore({ downloadImpl, failureTtlMs: 20 }, async store => {
    await assert.rejects(store.download('acct', 'm1', message, sock, 'image/jpeg'), /gone/);
    await new Promise(resolve => setTimeout(resolve, 40));
    const file = await store.download('acct', 'm1', message, sock, 'image/jpeg');
    assert.equal(file.buffer.toString(), 'ok');
  });
});

test('concurrent requests for one attachment share a single download', async () => {
  let calls = 0;
  const downloadImpl = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return Buffer.from('bytes'); };
  await withStore({ downloadImpl }, async store => {
    const [a, b] = await Promise.all([
      store.download('acct', 'm1', message, sock, 'image/png'),
      store.download('acct', 'm1', message, sock, 'image/png'),
    ]);
    assert.equal(calls, 1);
    assert.equal(a.buffer.toString(), 'bytes');
    assert.equal(b.type, 'image/png');
  });
});

test('a downloaded attachment is served from the disk cache by a fresh store', async () => {
  let calls = 0;
  const downloadImpl = async () => { calls++; return Buffer.from('bytes'); };
  await withStore({ downloadImpl }, async (store, cacheDir) => {
    await store.download('acct', 'm1', message, sock, 'image/png');
    const reopened = createMediaStore({ cacheDir, downloadImpl });
    const file = await reopened.download('acct', 'm1', message, sock, 'image/png');
    assert.equal(calls, 1);
    assert.equal(file.type, 'image/png');
  });
});
