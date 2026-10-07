# Gakai — Self-Hosted WhatsApp Workspace

> Manage multiple WhatsApp accounts from one clean dashboard. Deploy on your own server. Your data never leaves your infrastructure.

[![Docker](https://img.shields.io/badge/Docker-required-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/get-docker/)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-brightgreen)]()

**Gakai** is an open-source WhatsApp workspace you host yourself. It gives you a multi-account inbox, real-time messaging, media support, and an automation gateway — running entirely inside your own Docker stack, with no SaaS in the message path.

---

## Table of Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Not yet supported](#not-yet-supported)
- [Requirements](#requirements)
- [Installation](#installation)
- [Accessing Gakai](#accessing-gakai)
- [Adding WhatsApp Accounts](#adding-whatsapp-accounts)
- [Automation & AI](#automation--ai)
- [API reference](docs/api.md)
- [Reverse Proxy & HTTPS](#reverse-proxy--https)
- [Environment Variables](#environment-variables)
- [Operations](#operations)
- [Architecture](#architecture)
- [Security](#security)
- [Development](#development)
- [Tech Stack](#tech-stack)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## How it works

Gakai runs as **one Docker container**, started with a single `docker compose up`:

| Container | What it does | Exposed? |
|---|---|---|
| `gakai` | Dashboard, authentication, API, WhatsApp connectivity, automation gateway | Yes — port 3000 |

There is no separate WhatsApp provider process to run, configure, or pull. Gakai connects to WhatsApp directly, in-process, using [Baileys](https://github.com/WhiskeySockets/Baileys) — an open-source WhatsApp Web client library. Nothing outside Gakai's own image is pulled or contacted to send or receive a message.

> **Dependency note:** Gakai's WhatsApp connectivity is a direct, self-maintained integration (`@whiskeysockets/baileys`) baked into the Gakai image — there is no third-party WhatsApp service, no second container, and no external pull in the message path. Remaining roadmap work is publishing a signed `docker pull gakai` registry image, not another architecture change.

---

## Features

| Feature | Status |
|---|---|
| Multi-account WhatsApp sessions | ✅ Live |
| QR-code pairing flow in browser | ✅ Live |
| Receive & view text, image, audio, video, documents, stickers | ✅ Live |
| Send text messages (with @-mentions and reply/quote) | ✅ Live |
| Send media — image / video / document / voice note, with caption | ✅ Live |
| Start a new conversation from a phone number (with contact suggestions) | ✅ Live |
| Delivery / read status ticks on sent messages | ✅ Live |
| Location, shared-contact, poll, and view-once message rendering | ✅ Live |
| Group chats with sender identity | ✅ Live |
| Group @-mentions — participant autocomplete in the composer | ✅ Live |
| Mention alerts — toast when you're @-tagged in a group | ✅ Live |
| Message reactions | ✅ Live |
| Reply / quote, delete for everyone | ✅ Live |
| Forward a message to another conversation | ✅ Live |
| Edit a sent message (within WhatsApp's time window) | ✅ Live |
| Star a message; pin / mute / archive a chat | ✅ Live |
| Block / unblock a contact; disappearing-messages toggle | ✅ Live |
| Unread counts and bold unread state | ✅ Live |
| Conversation list from a local index — latest 50 by activity, pinned chats on top, cursor paging in the API | ✅ Live |
| Names resolved in one place (contact, WhatsApp label, business, push name, formatted phone); LID and phone identities kept as one chat | ✅ Live |
| WhatsApp Status, broadcast lists and channels kept out of the conversation list | ✅ Live |
| Replies show what they quote — photo, video, voice note, document, link title — with its thumbnail | ✅ Live |
| Integration API: send, read, per-token account, optional account guard, account picker (see [docs/api.md](docs/api.md)) | ✅ Live |
| Inbox filters — all / unread / groups / archived / starred | ✅ Live |
| Media relay (images, documents, voice notes) | ✅ Live |
| Open Graph and Instagram link previews | ✅ Live |
| AI auto-replies — OpenAI-compatible proxy, Claude or ChatGPT, in a per-person voice | ✅ Live |
| Webhook automation subscriptions | ✅ Live |
| scrypt password hashing (salted) | ✅ Live |
| Direct, in-process Baileys WhatsApp integration — no provider process | ✅ Live |
| Authenticated automation webhook delivery (per-subscription secret) | ✅ Live |
| SQLite state in WAL mode | ✅ Live |
| `/healthz` and `/readyz` endpoints | ✅ Live |
| Provider-adapter architecture — WhatsApp connectivity isolated behind `src/providers/` | ✅ Live |
| SSE / WebSocket real-time push | ✅ Live — authenticated SSE plus WebSocket typing/presence |
| Single-container distribution (no external pull) | ✅ Live — remaining work is publishing a signed `docker pull gakai` registry image, not another architecture change |

---

## Not yet supported

WhatsApp capabilities Gakai does not have yet, roughly in priority order. Each
note points at where the work would live.

### Next up

| Gap | Notes |
|---|---|
| **Group management** | Create group, add / remove / promote participants, change subject / icon, leave. `sock.groupCreate` / `groupParticipantsUpdate` / `groupUpdateSubject` / `groupUpdateDescription` / `groupLeave` / `updateProfilePicture`. Needs a group-info screen. |

### Out of scope (for now)

Status / stories, calls, payments, channels, communities.

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Docker Engine | 24+ | or Docker Desktop |
| Docker Compose plugin | v2+ | bundled with Docker Desktop |
| `openssl` | any | generates secrets on first run |
| Port 3000 | free | configurable via `GAKAI_PORT` |

No Node.js required on the host. Everything runs inside the one container.

---

## Installation

### 1. Install Docker

If you don't have Docker installed yet:

- **Mac / Windows:** download [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Linux (Ubuntu/Debian):**
  ```sh
  curl -fsSL https://get.docker.com | sh
  ```
- **Linux (other):** follow the [official Docker install guide](https://docs.docker.com/engine/install/)

Verify it's working:
```sh
docker --version
docker compose version
```

### 2. Clone and start

```sh
git clone https://github.com/tadeubanzato/gakai.co.git
cd gakai.co
./scripts/gakai-up.sh
```

The launcher:
1. Checks Docker and Docker Compose are available
2. Verifies the target port is free
3. Generates a private `.env` with random internal secrets (first run only)
4. Builds the Gakai image and starts the container
5. Prints the URL to open

Output when ready:

```
Gakai URL:      http://<server-lan-ip>:3000
Readiness:      http://<server-lan-ip>:3000/readyz
```

### 3. Create your admin account

1. Open the **Gakai URL** printed by the launcher in your browser
2. Gakai shows the **Create Account** screen on first visit
3. Enter a username (3–40 characters) and password (10+ characters)
4. Your password is stored as a **salted scrypt hash** — never in plaintext

### Custom port (optional)

By default Gakai runs on port **3000**. If that port is already in use on your machine, you can pick any other port:

```sh
GAKAI_PORT=8080 ./scripts/gakai-up.sh
```

Then open the URL printed by the launcher instead.

### Bind to localhost only (optional)

```sh
GAKAI_BIND_ADDRESS=127.0.0.1 ./scripts/gakai-up.sh
```

---

## Accessing Gakai

### Local network

From any device on the same network:

```
http://192.168.1.20:3000
```

### Public access

Gakai does not terminate TLS. For internet-facing deployments, put it behind a reverse proxy (see [Reverse Proxy & HTTPS](#reverse-proxy--https)).

---

## Adding WhatsApp Accounts

1. Sign in to the Gakai dashboard
2. Click **+ Add account** at the top of the inbox
3. Scan the QR code with WhatsApp on your phone:
   - WhatsApp → **Settings** → **Linked Devices** → **Link a Device**
4. The account appears in the inbox once pairing completes
5. Repeat for each additional phone number

Sessions persist across restarts. If a session expires, the dashboard prompts you to re-scan.

---

## Automation & AI

Gakai includes a built-in automation gateway. Each WhatsApp account has its own
settings page (`/profile-settings/<account name>`), reached from the **⚙ icon next to
the account** or from **Settings** (the gear at the top right of Home) → **Manage**.
It has three tabs: **Connection**, **AI responses** and **AI Voice and Tone**. Workspace-wide
things — the WhatsApp accounts list (and **Add account**), your sign-in details and the
application tokens — live on the **Settings** page (`/settings`).

AI replies only fire for messages you would need to act on personally — direct messages from
people you listed, and group messages in groups you listed where the account is explicitly
**@-tagged** — not every message in every group.

### AI replies

1. Open the account's settings (⚙) → **AI responses** tab
2. Pick a provider — **LiteLLM** (your own proxy URL + key), **Claude**, or **ChatGPT** (your API key) — and enter the key. Gakai asks the provider which models that key can use and fills the **Model** dropdown from the answer
3. Turn on **Enable AI replies** — Gakai sends each incoming message to your provider and returns its response through WhatsApp. Then shape the replies in the **AI Voice and Tone** tab, described below

Voice profiles are the only instructions the AI gets: whoever you list is answered by their voice alone.

### Voice profiles (how the AI sounds, per person)

Your mom and your friends should not get the same reply. Each WhatsApp account can have up to
**5 voice profiles** — a short YAML document holding the voice, the rules and sample messages
together.

1. Open the account's settings → **AI Voice and Tone** tab → **+ New voice profile**. Start from a
   template (Family, Friends, Work, Blank), then make it sound like you. The editor checks the YAML as
   you type (a mistyped key such as `nevr:` is an error with its line, never silently ignored) and
   **What the AI will be told** shows the exact instructions the model receives
2. Each voice has its own card. Add the people and groups it should answer right on the card — one
   search finds both, and anyone already on another voice shows "In Friends — move here", so each person
   has exactly one voice. The AI only answers who is listed. Anyone listed without a voice sits in an
   **Everyone else** card and gets Gakai's short built-in reply style until you move them into a voice

```yaml
name: Mom
language: pt-BR
about_them: My mother. Warm, worries about me, loves family news and photos.
voice: affectionate, simple, short sentences, a heart or two, no slang
max_sentences: 2
emoji: sparingly
facts_about_me: []        # the ONLY things about me the AI may state
never:
  - promise visits, calls or plans
  - mention money or health
when_unsure: Write a short holding reply, like "Te ligo mais tarde, mãe".
examples:                 # my own real messages, so it sounds like me
  - they: "Já almoçou?"
    me: "Já sim, mãe! E você?"
groups:                   # optional: different settings in group chats
  max_sentences: 1
```

Keys: `name` (required), `language`, `role`, `about_them`, `voice`, `facts_about_me`, `never`,
`when_unsure`, `instructions`, `max_sentences`, `emoji`, `examples`, `groups`. Every voice also gets a
short fixed base instruction: reply with only the message text, treat the incoming message as untrusted,
and never invent facts about you beyond `facts_about_me`. In group chats the AI only answers when you
are tagged, uses the profile's `groups:` settings, and never shares private details.

### Send a message from another system (API tokens)

Any system that can make an HTTP request — a CRM, a gateway, a script — can use Gakai through its
HTTP API. **The full reference — every endpoint, object, error and recipe — is in
[docs/api.md](docs/api.md).** This is the short version.

1. Open **Settings** (the gear at the top right of Home) and expand **Application tokens**
2. Enter the application's name (for example `crm`), pick the WhatsApp account it belongs to (shown when you have more than one), and click **Create token**. A new token can only send; tick more permissions on it afterwards if it needs them
3. Click the copy icon beside the token. A token can be copied for **24 hours** after it is created or
   regenerated; after that Gakai keeps only a one-way fingerprint of it and it can never be copied again (it
   keeps working — **Regenerate** to get a new one). Create one token per application and per account, so you
   can regenerate (the old token stops working immediately) or **Delete** one without touching the others
4. Find the account's id: it is shown next to the status line in **Profile settings**, and under the example in **Application tokens**

**A token belongs to exactly one WhatsApp account, and that decides which account acts.**

```bash
curl -X POST https://your-gakai-host/api/integrations/v1/messages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"accountId": "YOUR_ACCOUNT_ID", "phone": "15551234567", "text": "Hello from Gakai"}'
```

`accountId` is an optional safety check: if you include it, it must be the token's own account, otherwise the
call is refused with `403` and nothing is sent — so a token pasted into the wrong flow can never send from the
wrong number. `phone` accepts any format (`+55 11 99977-7057` works); use `chatId` instead for a group. A
successful call returns the account it sent from, the chat, and the sent message.

| Endpoint | Permission | What it does |
|---|---|---|
| `POST /api/integrations/v1/messages` | **Send messages** (default) | Send a text message from the token's account |
| `GET /api/integrations/v1/account` | any token | Which account this token belongs to (id, name, number, status) |
| `GET /api/integrations/v1/accounts` | **Read accounts** | Every account's id, name, number and status, sorted by name — for an account dropdown |
| `GET /api/integrations/v1/chats` | **Read messages** | The account's most recent conversations |
| `GET /api/integrations/v1/messages?chatId=…` | **Read messages** | The latest messages of one chat |

**Read accounts** is the one permission that sees beyond a token's own account: it lists the names, numbers
and ids of *all* your accounts (never their messages), is off by default, and should only go to an application
that needs an account picker.

### Custom webhook subscriptions

Additional webhook subscriptions can be registered per account through the
`POST /api/app/accounts/:id/automations` endpoint. Gakai POSTs the normalized
event (same shape as below) with an `x-gakai-secret` header for authentication.

### Example payload

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

For a group chat, `chat.kind` is `"group"` and `chat.id` ends in `@g.us` instead. `mentionsYou` is `true` only when the account is @-tagged in a group. More detail, including the `replyTo` object, is in [docs/api.md](docs/api.md#webhooks-events-gakai-sends-you). Gakai normalizes every WhatsApp payload before forwarding — your automation never sees provider-specific internals, and the JID shape above (`@s.whatsapp.net`/`@g.us`) is Baileys' real format, not a placeholder.

---

## Reverse Proxy & HTTPS

### nginx

```nginx
server {
    listen 443 ssl;
    server_name gakai.example.com;

    ssl_certificate     /etc/ssl/certs/gakai.crt;
    ssl_certificate_key /etc/ssl/private/gakai.key;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection keep-alive;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

### Caddy

```
gakai.example.com {
    reverse_proxy localhost:3000
}
```

---

## Environment Variables

All variables are optional. The launcher sets safe defaults automatically.

| Variable | Default | Description |
|---|---|---|
| `GAKAI_STATE_SECRET` | _(auto-generated)_ | Encrypts sensitive values Gakai stores locally (e.g. application tokens) |
| `GAKAI_PORT` | `3000` | Host port Gakai listens on |
| `GAKAI_BIND_ADDRESS` | `0.0.0.0` | Network interface (`127.0.0.1` for local-only) |
| `GAKAI_PUBLIC_URL` | _(auto-detected)_ | Overrides the URL the launcher prints, for a reverse proxy or domain name |
| `GAKAI_SESSION_TTL_MS` | `86400000` (24h) | How long an admin login session stays valid |
| `GAKAI_INBOX_CHAT_LIMIT` | `50` | Page size of the conversation list: how many conversations load at a time (1–200). The list is the latest activity, newest first, with pinned chats on top and no age cutoff |
| `GAKAI_INSTAGRAM_PREVIEW_RETRY_MS` | `300000` (5m) | Retry delay for a failed Instagram link-preview fetch |

> Do not edit `.env` manually. The launcher manages it — `GAKAI_STATE_SECRET` is auto-generated with `openssl rand -hex 32` on first run and is never exposed to the browser or logs. See `.env.example` for the authoritative, commented list.

---

## Operations

### Check container status

```sh
docker compose ps
```

### View logs

```sh
docker compose logs -f gakai
```

### Health checks

```sh
curl http://localhost:3000/healthz
# → {"ok":true,"service":"gakai"}

curl http://localhost:3000/readyz
# → {"ok":true,"service":"gakai","provider":true}
```

`readyz` reports the WhatsApp connectivity layer as always ready — there's no separate provider process whose reachability it needs to check anymore; it's in-process.

### Stop

```sh
docker compose down
```

### Upgrade

```sh
git pull --ff-only origin main
./scripts/gakai-up.sh
```

The launcher rebuilds the Gakai image and restarts the container. Data in `home-data/` and `sessions/` is preserved.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Browser                          │
│            (your computer / phone / tablet)             │
└───────────────────────┬─────────────────────────────────┘
                        │  HTTP/HTTPS  (your reverse proxy)
                        ▼
┌─────────────────────────────────────────────────────────┐
│                    gakai  :3000                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Authentication    scrypt · session tokens        │   │
│  │  Account manager   Baileys socket per account     │   │
│  │  WhatsApp adapter  src/providers/baileys — in-     │   │
│  │                    process, direct, no HTTP hop    │   │
│  │  Message shaping   normalize provider payloads    │   │
│  │  Media relay       cached · ranged responses      │   │
│  │  Automation        authenticated webhook gateway  │   │
│  │  SQLite state      WAL mode · durable             │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼  (outbound only — Baileys' own
                            WebSocket connection to WhatsApp)
```

**Design rules:**

- The browser talks only to Gakai — never receives WhatsApp credentials or direct provider access
- Provider payloads are normalized at the server boundary (`src/domain/message.mjs`) before reaching the UI
- WhatsApp connectivity is isolated behind `src/providers/` so the adapter (currently Baileys) could be swapped without changing the Gakai API or UI
- No separate provider process, no internal Docker network, no second image to pull — one container, one outbound connection (to WhatsApp itself)

---

## Security

| Concern | How Gakai handles it |
|---|---|
| Password storage | scrypt + random salt, stored as hex hash — never plaintext |
| Session tokens | 32-byte cryptographically random, `HttpOnly; SameSite=Strict` cookie |
| Timing attacks | `timingSafeEqual` for all credential comparisons |
| Stored secrets (e.g. application tokens) | Encrypted at rest with AES-256-GCM, keyed by `GAKAI_STATE_SECRET` |
| Automation webhook delivery | Authenticated with a per-subscription secret header (`x-gakai-secret`), HTTPS-only |
| Media relay | Served only through Gakai's own on-demand endpoint (`/api/app/media`), never a raw provider URL; SSRF guard on external fetches |
| Browser isolation | The browser never receives WhatsApp session credentials or talks to Baileys directly — only Gakai's own `/api/app/*` endpoints |

---

## Development

### Validate JavaScript (no local Node needed)

```sh
docker compose build gakai
docker compose run --rm --no-deps gakai node --check /gakai/public/assets/app.js
docker compose run --rm --no-deps gakai node --check /gakai/server.mjs
```

`docker compose build` runs esbuild on `client/*.jsx` as part of the image build, so it catches JSX/bundling errors; `node --check` then validates the compiled, JSX-free output.

### Run tests (no local Node needed)

```sh
docker build --target test -t gakai-test .
docker run --rm gakai-test
```

The shipped runtime image is intentionally lean and doesn't carry `package.json` or `test/`, so tests run against the Dockerfile's `test` stage — a throwaway stage built on top of the already-`npm ci`'d frontend stage, never part of the published image.

### Rebuild after changes

```sh
docker compose up -d --build
```

### Fixtures

Sanitized provider payload fixtures live in `test/fixtures/providers/baileys/`. Use them to develop message rendering without a live WhatsApp session. Never add real phone numbers, names, message content, or credentials.

### Project structure

```
gakai.co/
├── server.mjs              # Node HTTP server — auth, API, in-process WhatsApp integration, automation
├── client/
│   ├── app.jsx             # React browser application — accounts, pairing/QR
│   ├── chat.jsx            # Conversation view — composer, message list, presence
│   ├── chat-helpers.mjs    # Pure helpers: pagination, optimistic send, message merge, @-mention parsing
│   ├── app-helpers.mjs     # Shared fetch wrapper and async-mutex helper
│   ├── confirm.jsx         # App-wide confirmation dialog (replaces window.confirm)
│   └── ui-helpers.jsx      # Shared UI bits (avatar, icons)
├── public/
│   ├── assets/app.js       # esbuild output of client/ (generated, gitignored)
│   ├── styles.css          # Dashboard styles
│   └── index.html          # Entry document
├── src/
│   ├── domain/             # Message/chat normalization, JID classification, display names, conversation paging — provider payload in, Gakai view model out (fixture-tested)
│   ├── providers/
│   │   ├── baileys/        # The WhatsApp adapter: socket lifecycle, local SQLite store, media cache
│   │   ├── mock/            # In-memory test double with the same method surface, used by the test suite
│   │   └── index.mjs        # Single provider-selection point
│   ├── lib/                # Small shared utilities (SSRF-guarded fetch, LRU cache, HTML helpers)
│   ├── api/                # Planned provider-neutral API layer
│   ├── storage/            # Planned storage abstraction
│   ├── realtime/           # Realtime extraction target; current endpoints live in server.mjs
│   └── worker/             # Planned background worker
├── docs/
│   └── api.md              # Integration API reference
├── scripts/
│   └── gakai-up.sh         # One-command launcher
├── docker-compose.yml      # The one-container stack
├── Dockerfile              # The Gakai image (Node 22 Alpine, Baileys in-process)
└── test/fixtures/          # Sanitized provider payload fixtures
```

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 on Alpine Linux |
| Server | Native `node:http` — no framework |
| WhatsApp connectivity | [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) — direct, in-process, no provider service |
| Storage | `node:sqlite` in WAL mode — zero external dependency |
| Auth & secrets | `node:crypto` — scrypt password hashing, AES-256-GCM for stored secrets, timing-safe comparison |
| Frontend | React 19, bundled with esbuild |
| Deployment | Docker Compose — one container |

---

## Roadmap

1. **Provider-neutral message model** — ✅ stable domain types (`src/domain/message.mjs`), fixture-based rendering tests, and a clean adapter boundary (`src/providers/`) are live; hardening of identity/JID handling, group metadata, and receipts is ongoing
2. **Durable event storage** — ✅ idempotent event persistence and SSE replay are live (`app_events`, `/api/app/events`)
3. **Real-time browser push** — ✅ authenticated SSE and WebSocket typing/presence are live
4. **Production topology** — Postgres, object storage, multi-instance health monitoring
5. **Signed registry image** — publish `docker pull gakai`; the single-container image itself is already the shipped runtime, this is packaging/distribution only
6. **CI and signed releases** — automated builds, versioned images, changelog generation

---

## Contributing

1. Fork the repo and create a feature branch:
   ```sh
   git checkout -b feature/your-feature-name
   ```
2. Keep changes focused — one concern per commit, short imperative messages
3. Add sanitized fixtures for any change that touches provider payload shapes
4. Validate your JavaScript inside the container before opening a PR:
   ```sh
   docker compose build gakai
   docker compose run --rm --no-deps gakai node --check /gakai/public/assets/app.js
   docker compose run --rm --no-deps gakai node --check /gakai/server.mjs
   ```
5. Run the test suite:
   ```sh
   docker build --target test -t gakai-test .
   docker run --rm gakai-test
   ```
6. Open a pull request against `main`

**Never commit:** `.env`, `sessions/`, `home-data/`, real WhatsApp payloads, phone numbers, or credentials.

---

## License

MIT © [Tadeu Banzato](https://github.com/tadeubanzato)

---

<details>
<summary>Search keywords</summary>

self-hosted whatsapp · whatsapp workspace · whatsapp dashboard · whatsapp web client · whatsapp docker · whatsapp docker compose · whatsapp multi-account · whatsapp automation · whatsapp webhook · whatsapp open source · whatsapp self-hosted server · whatsapp inbox · whatsapp team dashboard · whatsapp api gateway · self-hosted messaging · gakai

</details>
