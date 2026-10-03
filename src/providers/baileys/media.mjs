/**
 * Message media (images, video, audio, documents, stickers) has no
 * standalone fetchable URL under Baileys — unlike the old provider's
 * `/api/files/...` proxy, every attachment must be decrypted on demand from
 * the full message object via `downloadMediaMessage`. This caches that
 * decrypted result — in memory for hot reads, on disk so a restart or an
 * evicted cache entry doesn't force a re-download from WhatsApp — keyed by
 * account + message id.
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBoundedCache } from '../../lib/lru-cache.mjs';

// Neither wait below is bounded by Baileys itself. A re-upload request waits
// on the phone with no timeout at all, and a download whose connection drops
// mid-stream never settles — either one would otherwise hold the browser's
// request (and one of its few connections to Gakai) open indefinitely.
const DOWNLOAD_TIMEOUT_MS = 90 * 1000;
const REUPLOAD_TIMEOUT_MS = 15 * 1000;
// An attachment that just failed is not asked for again straight away, so
// reopening the same chat doesn't sit through the same wait every time.
const FAILURE_TTL_MS = 60 * 1000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(message), { status: 504 })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createMediaStore({
  cacheDir, logger,
  downloadImpl = downloadMediaMessage,
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
  reuploadTimeoutMs = REUPLOAD_TIMEOUT_MS,
  failureTtlMs = FAILURE_TTL_MS,
}) {
  const memory = createBoundedCache({ limit: 24 });
  const failures = createBoundedCache({ limit: 500, ttlMs: failureTtlMs });
  // Several elements can ask for the same attachment at once (a preview and
  // its player, a poll overlapping a page load) — share one download.
  const inflight = new Map();
  const fileKey = messageId => createHash('sha1').update(messageId).digest('hex');
  const binPath = (accountId, messageId) => join(cacheDir, accountId, `${fileKey(messageId)}.bin`);
  const metaPath = (accountId, messageId) => join(cacheDir, accountId, `${fileKey(messageId)}.json`);

  async function fromDisk(accountId, messageId) {
    try {
      const [buffer, metaRaw] = await Promise.all([
        readFile(binPath(accountId, messageId)),
        readFile(metaPath(accountId, messageId), 'utf8'),
      ]);
      return { buffer, type: JSON.parse(metaRaw).type || 'application/octet-stream' };
    } catch { return null; }
  }

  async function toDisk(accountId, messageId, value) {
    try {
      await mkdir(join(cacheDir, accountId), { recursive: true });
      await Promise.all([
        writeFile(binPath(accountId, messageId), value.buffer),
        writeFile(metaPath(accountId, messageId), JSON.stringify({ type: value.type })),
      ]);
    } catch (error) {
      logger?.warn?.({ error: error.message }, 'Failed to persist media to disk cache');
    }
  }

  async function fetchAndCache(key, accountId, messageId, waMessage, sock, mimetype) {
    const disk = await fromDisk(accountId, messageId);
    if (disk) { memory.set(key, disk); return disk; }
    const failure = failures.get(key);
    if (failure) throw Object.assign(new Error(failure.message), { status: failure.status });
    let buffer;
    try {
      buffer = await withTimeout(
        downloadImpl(
          waMessage,
          'buffer',
          {},
          { logger, reuploadRequest: message => withTimeout(sock.updateMediaMessage(message), reuploadTimeoutMs, 'The phone did not re-upload this attachment in time') },
        ),
        downloadTimeoutMs,
        'Attachment download timed out',
      );
    } catch (error) {
      failures.set(key, { message: error.message || 'Attachment download failed', status: error.status });
      throw error;
    }
    const value = { buffer, type: mimetype || 'application/octet-stream' };
    memory.set(key, value);
    if (buffer.length <= 25 * 1024 * 1024) await toDisk(accountId, messageId, value);
    return value;
  }

  // waMessage: the raw Baileys proto.IWebMessageInfo for this message (as
  // stored by the local store). sock: the live socket for this account, used
  // to re-request media whose short-lived download URL has already expired.
  async function download(accountId, messageId, waMessage, sock, mimetype) {
    const key = `${accountId}:${messageId}`;
    const cached = memory.get(key);
    if (cached) return cached;
    const pending = inflight.get(key);
    if (pending) return pending;
    const task = fetchAndCache(key, accountId, messageId, waMessage, sock, mimetype).finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }

  return { download };
}
