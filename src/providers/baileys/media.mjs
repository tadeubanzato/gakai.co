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

export function createMediaStore({ cacheDir, logger }) {
  const memory = createBoundedCache({ limit: 24 });
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

  // waMessage: the raw Baileys proto.IWebMessageInfo for this message (as
  // stored by the local store). sock: the live socket for this account, used
  // to re-request media whose short-lived download URL has already expired.
  async function download(accountId, messageId, waMessage, sock, mimetype) {
    const key = `${accountId}:${messageId}`;
    const cached = memory.get(key);
    if (cached) return cached;
    const disk = await fromDisk(accountId, messageId);
    if (disk) { memory.set(key, disk); return disk; }
    const buffer = await downloadMediaMessage(
      waMessage,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    );
    const value = { buffer, type: mimetype || 'application/octet-stream' };
    memory.set(key, value);
    if (buffer.length <= 25 * 1024 * 1024) await toDisk(accountId, messageId, value);
    return value;
  }

  return { download };
}
