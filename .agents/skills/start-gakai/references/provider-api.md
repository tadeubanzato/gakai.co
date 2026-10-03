# Provider API reference

Use this reference when touching the WhatsApp provider adapter, its payloads, events, capability, or compatibility checks. It is internal engineering context, not customer-facing Gakai documentation.

## Official documentation

- [Baileys reference (baileys.wiki)](https://baileys.wiki)
- [Baileys source and issue tracker (GitHub)](https://github.com/WhiskeySockets/Baileys)

## Current Gakai boundary

- The browser calls only `/api/app/*` and `/api/integrations/v1/*`; it never calls the provider or receives provider credentials.
- `server.mjs` is the current adapter boundary. Normalize provider payloads/events there before returning data to the browser.
- The WhatsApp connection runs in-process — there is no separate provider container, no provider host port, and no provider REST API to reach over the network.
- Never paste real credentials, phone numbers, message text, session files, media, or raw production payloads into Git, fixtures, logs, prompts, or the skill.

## Verified payload and endpoint notes

Superseded. The previous notes in this section described a REST/webhook provider (session-scoped HTTP endpoints, webhook signature verification, polling for updates). Baileys is event-driven, not REST: it delivers WhatsApp state and messages as in-process events over a socket connection rather than as HTTP endpoints to call. There are no verified endpoint-shaped payload notes to record here yet — do not assume the old REST shapes (`/api/{session}/...`, `/api/sendText`, webhook envelopes) still apply. Read the current adapter code and the official Baileys documentation above before relying on any specific event or payload shape, and add verified notes here once confirmed.

### Verified against `@whiskeysockets/baileys@7.0.0-rc14` (checked in the runtime image)

- **Outbound media** — `sock.sendMessage(jid, content, { quoted })` where `content` is one of:
  - `{ image: Buffer, caption?, mimetype? }`
  - `{ video: Buffer, caption?, mimetype?, ptv? }` (`ptv: true` = video note)
  - `{ audio: Buffer, mimetype?, ptt?, seconds? }` (`ptt: true` = voice note)
  - `{ document: Buffer, mimetype (required), fileName?, caption? }`
  The returned value is a full `proto.IWebMessageInfo` with `key` + the media keys
  needed to decrypt/re-serve it later — the same object `messages.upsert` delivers,
  so `messageView` and `media.download` consume it unchanged.
- **`sock.onWhatsApp(...numbers: string[])`** → `Promise<{ jid: string, exists: boolean }[] | undefined>`.
  Accepts bare digits or a full jid. Used to check a number before opening a new chat.
- **`messages.update` event** → `{ key: WAMessageKey, update: Partial<WAMessage> }[]`.
  Delivery/read progress arrives as `update.status`, a `proto.WebMessageInfo.Status`
  enum number: `ERROR 0, PENDING 1, SERVER_ACK 2, DELIVERY_ACK 3, READ 4, PLAYED 5`.
- **Unread state is Gakai's own, never Baileys'.** `chats.update.unreadCount` is a *delta*
  (+1 per incoming message, `-1`/`0`/`null` from app-state read marks) and
  `messaging-history.set` carries absolute counts; treating either as the stored count makes
  read chats reappear as unread. Gakai instead keeps `wa_chats.read_ts` (a forward-only read
  cursor) and `wa_messages.unread` (set once, when a live incoming message is first stored;
  history never sets it); the count is derived. `messages.upsert` types `notify` and `append`
  both count, `append` being offline delivery. An incoming key with `status >= READ` in
  `messages.update` means the owner read it on another device and clears it locally
  (`isReadElsewhere`). `markChatRead(account, chat, { through })` moves the cursor first and
  sends `sock.readMessages` only for messages that were still unread.
- **Structured inbound types** — `normalizeMessageContent` already unwraps
  `viewOnceMessage*`, `ephemeralMessage`, `documentWithCaptionMessage`,
  `editedMessage`; `locationMessage`, `contactMessage`/`contactsArrayMessage`, and
  `pollCreationMessage*` are leaf types it does not unwrap.
- **Forward** — `sock.sendMessage(jid, { forward: waMessage })` where `waMessage`
  is a stored `proto.IWebMessageInfo` (from `store.getMessageById`). Returns a
  normal sent-message object.
- **Edit** — `sock.sendMessage(jid, { text, edit: waMessage.key })`. WhatsApp
  only accepts an edit within ~15 minutes of the original send.
- **Chat state** — `sock.chatModify(mod, jid)`: `{ pin: boolean }`,
  `{ mute: number | null }` (epoch **ms** to mute until; `null` unmutes),
  `{ archive: boolean, lastMessages: [{ key, messageTimestamp }] }`.
- **Star** — `sock.star(jid, [{ id, fromMe }], starOn: boolean)` — per message.
- **Block** — `sock.updateBlockStatus(jid, 'block' | 'unblock')`; current
  blocklist via `blocklist.set` (full) / `blocklist.update` (`{ blocklist, type }`)
  events.
- **Disappearing messages** — `sock.sendMessage(jid, { disappearingMessagesInChat: seconds })`
  (`0` off, `86400` 24h, `604800` 7d, `7776000` 90d).
- **Profile pictures** — `sock.profilePictureUrl(jid, 'preview')` returns a signed
  CDN link whose `oe` query parameter is the expiry (hex epoch seconds); the CDN
  answers 403 after it. A stored link is a cache only — see `picture.mjs`.
- **Media download waits are unbounded** — `sock.updateMediaMessage` (the
  re-upload request `downloadMediaMessage` makes on a 404/410) waits for the
  phone's `messages.media-update` with no timeout, and `downloadEncryptedContent`
  pipes the HTTP body without forwarding its errors, so a connection dropped
  mid-body raises an unhandled stream `'error'` and the buffer read never
  settles. Gakai bounds both in `media.mjs` and survives the stream error via
  `src/lib/process-guard.mjs`.
- **Delete a message** — your own: `sock.sendMessage(jid, { delete: key })` (a revoke,
  "delete for everyone"). Someone else's: WhatsApp ignores a revoke, so use
  `sock.chatModify({ deleteForMe: { deleteMedia, key, timestamp } }, jid)` — `timestamp` is
  Unix **seconds** as a plain number — which also removes it on the phone and linked devices.
- **Delete a conversation** — `sock.chatModify({ delete: true, lastMessages: [{ key, messageTimestamp }] }, jid)`.
  `getMessageRange` throws on a key without `id`/`remoteJid`, on a missing/zero timestamp, and
  on a group message from someone else with no `participant`. A stored message has been through
  JSON, so flatten its `messageTimestamp` to a number first. Gakai asks WhatsApp first and only
  then removes the chat locally, so a refused delete is reported rather than hidden.
- **Deletions made elsewhere** — `messages.delete` → `{ keys: WAMessageKey[] }` or
  `{ jid, all: true }` (chat cleared); `chats.delete` → `string[]` of chat ids (not emitted
  during initial sync). Gakai mirrors both, so a delete on the phone or another linked device
  disappears here too.
- **Presence** — `presence.update` reports a contact by whatever id WhatsApp uses (possibly a
  LID); relay it under the canonical chat id or it will not match the open chat.
- **Group** (deferred feature) — `groupCreate(subject, participants[])`,
  `groupParticipantsUpdate(jid, participants[], 'add'|'remove'|'promote'|'demote')`,
  `groupUpdateSubject(jid, subject)`, `groupUpdateDescription(jid, desc?)`,
  `groupLeave(jid)`, `updateProfilePicture(groupJid, WAMediaUpload)`.

## Integration procedure

1. Read the official Baileys documentation and, where useful, its source for the capability or event in question — do not assume a field or event name from memory.
2. Read the current adapter implementation; do not assume a documented shape is what Gakai's adapter actually normalizes.
3. Add or update a sanitized fixture and normalize the result into Gakai's stable domain shape.
4. Keep retries, idempotency, and ordering at the Gakai boundary.
5. Validate against a real WhatsApp connection without printing sensitive payload content.
6. For any Baileys version update, compare the changelog/release notes and Gakai fixtures before changing production behavior.

## Future replacement rule

These links describe the current provider integration only. New Gakai domain/API/UI code must not make the provider's names, environment variables, raw event schemas, or internal shapes part of a public Gakai contract. The adapter must remain replaceable.
