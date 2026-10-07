# Gakai API reference

How another system — a CRM, a gateway, a script — talks to Gakai over HTTP. Everything here
is under `/api/integrations/v1/` and authenticated with an **application token**.

The browser dashboard uses a separate set of routes (`/api/app/…`) behind the administrator
sign-in. Those are internal and may change between releases; this document covers the integration
API only.

- [Quick start](#quick-start)
- [Authentication](#authentication)
- [Application tokens](#application-tokens)
- [Permissions](#permissions)
- [Endpoints](#endpoints)
  - [`GET /account`](#get-account) · [`GET /accounts`](#get-accounts) · [`GET /chats`](#get-chats) · [`GET /messages`](#get-messages) · [`POST /messages`](#post-messages)
- [Objects](#objects)
- [Errors](#errors)
- [Recipes](#recipes)
- [Webhooks (events Gakai sends you)](#webhooks-events-gakai-sends-you)

## Quick start

1. In Gakai open **Settings → Application tokens**, name the application, choose the WhatsApp
   account it belongs to, and click **Create token**. Copy the token (see [lifetime of a token](#application-tokens)).
2. Find the account's id: **Profile settings** shows it next to the status line, and it is printed
   under the example in **Application tokens**.
3. Send a message:

```bash
curl -X POST https://your-gakai-host/api/integrations/v1/messages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"accountId": "YOUR_ACCOUNT_ID", "phone": "15551234567", "text": "Hello from Gakai"}'
```

All requests and responses are JSON (`Content-Type: application/json`). Timestamps on chats and
messages are Unix **seconds**. There is no rate limit built in; WhatsApp's own limits apply to what
you send.

## Authentication

Send the token in the `Authorization` header:

```
Authorization: Bearer wh_live_…
```

A missing or unknown token returns `401 {"message": "Invalid integration key"}`. A valid token
without the permission an endpoint needs returns `403` (see [Errors](#errors)).

## Application tokens

- **One token belongs to exactly one WhatsApp account.** The token — not anything in the request —
  decides which account a call acts on. Create one token per account and per application.
- **Least privilege.** A new token can only send messages. Tick the other permissions on the token
  in Settings if the application needs them. Permissions can be switched on and off at any time.
- **Copying.** A token can be copied from Settings for **24 hours** after it is created or
  regenerated. After that Gakai keeps only a one-way fingerprint, so the token can never be shown
  again (it keeps working). **Regenerate** issues a new secret and the old one stops working
  immediately; **Delete** removes the token.
- **Limit.** An account can have up to 20 tokens.
- **Treat a token like a password.** Anyone who has it can do whatever its permissions allow.

## Permissions

| Permission | Allows | Notes |
|---|---|---|
| *(any valid token)* | `GET /account` | Describes only the token's own account. |
| **Send messages** (`messages:send`) | `POST /messages` | The default for a new token. |
| **Read messages** (`messages:read`) | `GET /chats`, `GET /messages` | Limited to the token's own account. |
| **Read accounts** (`accounts:read`) | `GET /accounts` | **Workspace-wide.** Lists every account's id, name, number and status — never their messages or chats. Off by default; grant it only to an application that needs an account picker, because anyone holding such a token can see all your accounts. |

## Endpoints

Base path: `/api/integrations/v1`

### `GET /account`

Which account does this token belong to? Any valid token may call it. Use it to confirm a
gateway is wired to the account you expect.

```bash
curl https://your-gakai-host/api/integrations/v1/account \
  -H "Authorization: Bearer YOUR_TOKEN"
```

```json
{
  "account": { "id": "account-mtc6my6d", "label": "Tadeu", "phone": "18577075969", "status": "WORKING" },
  "token":   { "name": "crm", "scopes": ["messages:send", "messages:read"] }
}
```

- `status` is `WORKING` when connected, `SCAN_QR_CODE` when waiting to be paired, or `STARTING` while connecting.
- `phone` is `null` until the account is paired.
- If the account was deleted after the token was made: `404`.

### `GET /accounts`

Every WhatsApp account in the workspace, for an application's account dropdown.
Needs **Read accounts**.

```bash
curl https://your-gakai-host/api/integrations/v1/accounts \
  -H "Authorization: Bearer YOUR_TOKEN"
```

```json
{
  "accounts": [
    { "id": "account-4f1c2a9b", "label": "Business", "phone": "15551230001", "status": "WORKING", "current": false },
    { "id": "account-mtc6my6d", "label": "Tadeu",    "phone": "18577075969", "status": "WORKING", "current": true }
  ]
}
```

- Sorted by `label` (case-insensitive), then `id` — ready to use as a dropdown.
- `current` is `true` for the token's own account.
- Only `id`, `label`, `phone`, `status` and `current` are returned.
- To **send** from one of these accounts, use the token that belongs to it; this endpoint does not let a token act on another account.

### `GET /chats`

The account's most recent conversations (people and groups), newest activity first. Up to 35.
Needs **Read messages**. WhatsApp Status and broadcast lists are not conversations and never appear.

```bash
curl https://your-gakai-host/api/integrations/v1/chats \
  -H "Authorization: Bearer YOUR_TOKEN"
```

```json
{
  "accountId": "account-mtc6my6d",
  "chats": [
    {
      "id": "5511999777057@s.whatsapp.net",
      "name": "Jane Doe",
      "phone": "+55 11 99977 7057",
      "kind": "individual",
      "picture": null,
      "unreadCount": 0,
      "timestamp": 1791085030,
      "lastMessage": { "body": "See you then", "text": "See you then", "timestamp": 1791085030, "hasMedia": false, "system": null },
      "pinned": false, "muted": false, "archived": false, "ephemeral": 0, "blocked": false
    }
  ]
}
```

See [Chat](#chat).

### `GET /messages`

The latest 30 messages of one chat, **oldest first**. Needs **Read messages**.

| Query | Notes |
|---|---|
| `chatId` | Required. A `…@s.whatsapp.net` or `…@g.us` id from `GET /chats`. |

```bash
curl "https://your-gakai-host/api/integrations/v1/messages?chatId=5511999777057@s.whatsapp.net" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

```json
{ "messages": [ { "id": "3EB0F1A2B3C4D5E6F708", "timestamp": 1791085030, "fromMe": false, "body": "Hello", "...": "…" } ] }
```

See [Message](#message). Media is described (`hasMedia`, `media`) but the file itself is **not**
downloadable with a token: `mediaUrl` points at the dashboard and needs the administrator sign-in.

### `POST /messages`

Send a text message from the token's account. Needs **Send messages**.

| Field | Notes |
|---|---|
| `text` | **Required.** Up to 4096 characters. |
| `phone` (or `to`) | The number in any format: `+1 (857) 707-5969`, `+55 11 99977-7057`, `0055 11 99977 7057`, `18577075969` and `5511999777057` all work. Gakai sends into the existing chat with that number, or starts a new chat if the number is on WhatsApp. A number that is not on WhatsApp returns `404` and nothing is sent. |
| `countryCode` | Optional, for a number written **without** its country code: `1`, `+1`, `55`, `+55`, or a country such as `US` or `BR`. If omitted, Gakai assumes the country of the account's own number; if it still cannot tell it returns `400` rather than guess. |
| `chatId` | Use instead of `phone` to target a chat directly, for example a group (`120363…@g.us`). Wins if both are sent. |
| `accountId` | Optional safety check. The token decides the sending account; if you include `accountId` it must be that account's id, otherwise the request is refused with `403` and **nothing is sent**. It never selects an account — it only catches a token pasted into the wrong flow. |

```bash
curl -X POST https://your-gakai-host/api/integrations/v1/messages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"accountId": "account-mtc6my6d", "phone": "+55 11 99977-7057", "text": "Oi!"}'
```

```json
{
  "ok": true,
  "account": { "id": "account-mtc6my6d", "label": "Tadeu", "phone": "18577075969" },
  "chatId": "5511999777057@s.whatsapp.net",
  "to": "+5511999777057",
  "newChat": false,
  "message": { "id": "3EB0F1A2B3C4D5E6F708", "fromMe": true, "body": "Oi!", "...": "…" }
}
```

- `account` is the account the message was sent from.
- `to` is the normalized number Gakai used (`null` when you targeted a `chatId`).
- `newChat` is `true` when this call opened a conversation that did not exist yet.
- `message` is the sent [message](#message); its `ackName` starts as `PENDING`/`SERVER_ACK`.

A group example:

```json
{ "chatId": "120363000000000000@g.us", "text": "Hello group" }
```

## Objects

### Chat

| Field | Type | Notes |
|---|---|---|
| `id` | string | WhatsApp chat id (`…@s.whatsapp.net`, `…@lid`, or `…@g.us`). Use it as `chatId`. |
| `name` | string \| null | Best available display name: contact name, WhatsApp's chat label, business name, push name, formatted phone, and only as a last resort the id. Group subject for groups. |
| `phone` | string \| null | Formatted number for a person; `null` for groups and unmapped LIDs. |
| `kind` | string | `individual` or `group`. |
| `picture` | string \| null | Avatar URL when known. |
| `unreadCount` | number | Unread incoming messages. |
| `timestamp` | number | Time of the latest real message, Unix seconds. Delivery receipts and profile changes do not change it. |
| `lastMessage` | object \| null | `{ body, text, timestamp, hasMedia, system }`. |
| `pinned`, `muted`, `archived`, `blocked` | boolean | WhatsApp chat state. |
| `ephemeral` | number | Disappearing-message timer in seconds (`0` = off). |

### Message

| Field | Type | Notes |
|---|---|---|
| `id` | string | Message id. |
| `timestamp` | number | Unix seconds. |
| `fromMe` | boolean | `true` for messages the account sent. |
| `body`, `text` | string | The text, or the caption of media. Both carry the same value. |
| `system` | object \| null | Set for call and group events instead of text. |
| `hasMedia`, `media` | boolean, object \| null | `media` is `{ mimetype, filename, width, height, … }`. |
| `mediaUrl` | string \| null | Dashboard-only; not downloadable with a token. |
| `sender` | object \| null | `{ id, name, picture }` of who wrote it (useful in groups). |
| `mentionedJids` | string[] | People @-mentioned. |
| `replyTo` | object \| null | The message this one answers — see below. |
| `location`, `contacts`, `poll`, `vCards`, `linkPreview` | object \| null | Structured content, when the message is one. |
| `viewOnce`, `edited` | boolean | |
| `ackName` | string | Delivery state of a message you sent: `PENDING`, `SERVER_ACK`, `DELIVERY_ACK`, `READ`, `PLAYED` (or `ERROR`). |

**`replyTo`** describes the quoted message:

| Field | Notes |
|---|---|
| `id` | Id of the quoted message. |
| `participant` | Who wrote the quoted message, in a group. |
| `kind` | `text`, `image`, `video`, `gif`, `voice`, `audio`, `sticker`, `document`, `link`, or `unknown`. |
| `label` | One line saying what was quoted: the text itself, or `📷 Photo`, `🎥 Video 1:15`, `🎤 Voice message 0:07`, `📄 file.pdf`, `🔗 Page title`. |
| `caption` | The caption or the link address under the label, when there is one. |
| `body`, `hasMedia` | The raw quoted text and whether it was media. |
| `thumbnail` | A small JPEG as a `data:image/jpeg;base64,…` URI, when WhatsApp sent one with the quote. It adds a few KB to the payload; ignore it if you do not need it. |

## Errors

Errors are JSON: `{ "message": "…" }`.

| Status | When |
|---|---|
| `400` | A missing or invalid field: `chatId is required`; `"text" is required`; `"text" can be at most 4096 characters`; no `phone`/`chatId`; a phone number that cannot be placed (add `countryCode`). |
| `401` | `Invalid integration key` — missing, unknown or revoked token (a regenerated token's old secret also lands here). |
| `403` | `This integration key does not have permission for that action` — the token lacks the permission. Or the `accountId` you sent is not the token's account; the body then also carries `accountId` (the token's real one) and nothing was sent. |
| `404` | `That number is not on WhatsApp`; or, for `GET /account`, the token's account no longer exists. |
| `409` | `Account is not connected` — the WhatsApp account is signed out or still starting. |
| `502` | WhatsApp refused or failed the request; `message` says why. |

## Recipes

**Fill an account dropdown, then send from the chosen account**

1. Give *one* token **Read accounts** and call `GET /accounts` to populate the dropdown (`label` for display, `id` as the value).
2. Keep one token per account (created in Settings) and look up the token for the chosen `id` on your side.
3. Send with that account's token and put the same id in the body as `accountId`:

```bash
curl -X POST https://your-gakai-host/api/integrations/v1/messages \
  -H "Authorization: Bearer TOKEN_FOR_THAT_ACCOUNT" \
  -H "Content-Type: application/json" \
  -d '{"accountId": "ID_FROM_THE_DROPDOWN", "phone": "15551234567", "text": "Hello"}'
```

If the wrong token is picked up, step 3 fails with `403` and nothing is sent.

**Confirm a gateway is set up correctly:** call `GET /account` with each token and compare the returned `account.id`.

**Reply in a thread you just read:** `GET /chats` → pick `id` → `GET /messages?chatId=…` → `POST /messages` with the same `chatId`.

## Webhooks (events Gakai sends you)

Gakai can also call *you*. Register a subscription per account with
`POST /api/app/accounts/:id/automations`; Gakai then POSTs each normalized event to your URL with an
`x-gakai-secret` header carrying that subscription's secret. Verify it before trusting the payload.

```json
{
  "id": "evt_3EB0F1A2B3C4D5E6F708",
  "type": "message.received",
  "occurredAt": "2026-08-24T12:34:56.000Z",
  "account": { "id": "account-abc123" },
  "chat": { "id": "5511999999999@s.whatsapp.net", "kind": "direct", "phone": "5511999999999" },
  "message": {
    "id": "3EB0F1A2B3C4D5E6F708",
    "timestamp": 1700000000,
    "fromMe": false,
    "body": "Hello from WhatsApp",
    "text": "Hello from WhatsApp",
    "hasMedia": false,
    "media": null,
    "mediaUrl": null,
    "sender": { "id": "5511999999999@s.whatsapp.net", "name": "Jane Doe", "phone": "5511999999999" },
    "mentionedJids": []
  },
  "mentionsYou": false,
  "source": "whatsapp"
}
```

- `chat.kind` is `"direct"` or `"group"`; a group id ends in `@g.us`. `chat.phone` is set for direct chats.
- `mentionsYou` is `true` only when the account was @-tagged in a **group**.
- `message` has the same shape as a [Message](#message) (including `replyTo`).
- Only real content is delivered: calls, group-metadata changes and empty notifications are not.
- Gakai normalizes every WhatsApp payload before forwarding, so your automation never sees provider-specific internals.
