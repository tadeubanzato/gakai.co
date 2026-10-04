// Gakai keeps messages as JSON, where every protobuf `bytes` field (thumbnails, media keys, hashes)
// is a base64 string. Hand that straight to Baileys as the message being replied to and the copy
// it returns has those fields garbled — the thumbnail becomes bytes that are not an image — while
// the wire encoding stays correct. Rebuilding the message through Baileys' own protobuf type first
// turns the strings back into real bytes, so the copy Gakai stores is as good as what was sent.
import { proto } from '@whiskeysockets/baileys';

export function quotedForSend(stored) {
  return stored ? proto.WebMessageInfo.fromObject(stored) : null;
}
