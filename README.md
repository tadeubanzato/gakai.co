# Gakai — Self-Hosted WhatsApp Workspace

> Manage multiple WhatsApp accounts from one professional dashboard. Deploy on your own server in under two minutes. Your data never leaves your infrastructure.

[![Docker](https://img.shields.io/badge/Docker-required-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/get-docker/)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-brightgreen)]()

**Gakai** is an open-source, self-hosted WhatsApp web client built for teams and power users. It gives you a clean multi-account inbox, real-time messaging, media support, and an automation webhook gateway — deployed in a single Docker Compose stack, secured behind your own authentication, with no SaaS in the message path.

> **Built on [WAHA](https://waha.devlike.pro)** — Gakai wraps the WAHA WhatsApp HTTP API as its private session runtime. WAHA handles the low-level WhatsApp protocol; Gakai provides the product layer — authentication, inbox, media relay, automation gateway, and a clean browser UI — on top of it.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
  - [Quick start (one command)](#quick-start-one-command)
  - [First-time setup](#first-time-setup)
  - [Custom port](#custom-port)
  - [Bind to localhost only](#bind-to-localhost-only)
- [Accessing Gakai](#accessing-gakai)
  - [Local network](#local-network)
  - [Public / internet access](#public--internet-access)
  - [Reverse proxy (nginx example)](#reverse-proxy-nginx-example)
- [Adding WhatsApp Accounts](#adding-whatsapp-accounts)
- [Automation & Webhooks](#automation--webhooks)
- [Operations & Maintenance](#operations--maintenance)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Security](#security)
- [Private Data](#private-data)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Features

| Feature | Status |
|---|---|
| Multi-account WhatsApp sessions | ✅ |
| QR-code pairing flow in browser | ✅ |
| Text, image, audio, video, document messages | ✅ |
| Group chats with sender identity | ✅ |
| Unread counts and bold unread state | ✅ |
| Media relay (images, documents, voice notes) | ✅ |
| Instagram link previews | ✅ |
| Open Graph link previews for URLs | ✅ |
| n8n / webhook automation subscriptions | ✅ |
| Salted-hash admin authentication (scrypt) | ✅ |
| `/healthz` and `/readyz` endpoints | ✅ |
| SQLite-backed durable state (WAL mode) | ✅ |
| Docker Compose single-command deploy | ✅ |
| HMAC-signed provider webhook ingestion | ✅ |
| Provider-neutral architecture | 🔄 In progress |
| SSE / WebSocket real-time push | 🔄 Planned |
| Postgres + object storage topology | 🔄 Planned |

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Docker Engine | 24+ | or Docker Desktop |
| Docker Compose plugin | v2+ | bundled with Docker Desktop |
| `openssl` or `/dev/urandom` | any | used once on first run to generate secrets |
| Port 3000 | free | configurable via `GAKAI_PORT` |

No Node.js install required on the host. Everything runs inside the container.

---

## Installation

### Quick start (one command)

```sh
git clone https://github.com/tadeubanzato/gakai-zap.git
cd gakai-zap
./scripts/gakai-up.sh
```

The launcher script:
1. Validates Docker and Docker Compose are available
2. Checks the target port is free
3. Generates a private `.env` with a random internal credential (only on first run)
4. Builds the Gakai application image
5. Starts both the Gakai dashboard and its private provider runtime via `docker compose up -d --build`
6. Prints the URL to open

When it finishes you will see:

```
Gakai is starting. Open: http://gakai.localhost:3000
Check readiness: http://gakai.localhost:3000/readyz
```

### First-time setup

1. Open **http://gakai.localhost:3000** in your browser
2. Gakai detects no administrator exists and shows the **Create Account** screen
3. Enter a username (3–40 characters) and a password (minimum 10 characters)
4. Your password is stored as a **salted scrypt hash** in `home-data/` — never in plaintext

That's it. You are now logged in and ready to connect WhatsApp accounts.

### Custom port

If port 3000 is already in use, pass a different port before the script:

```sh
GAKAI_PORT=8080 ./scripts/gakai-up.sh
```

Then open `http://gakai.localhost:8080`.

### Bind to localhost only

By default Gakai accepts connections from the whole local network. To restrict it to the current machine only:

```sh
GAKAI_BIND_ADDRESS=127.0.0.1 ./scripts/gakai-up.sh
```

---

## Accessing Gakai

### Local network

From any device on the same network, use the server's IP address and port:

```
http://192.168.1.20:3000
```

For a stable LAN name (e.g. `gakai.local`), configure it through your router's DNS or an mDNS service like Avahi. Docker cannot create consistent mDNS names across all operating systems.

### Public / internet access

Gakai does not terminate TLS. For internet-facing deployments, place it behind an HTTPS reverse proxy and restrict access appropriately. **Never expose the internal provider container** (`gakai-provider`) to the internet — it has no host port by design.

### Reverse proxy (nginx example)

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

For Caddy, a minimal `Caddyfile`:

```
gakai.example.com {
    reverse_proxy localhost:3000
}
```

---

## Adding WhatsApp Accounts

1. Sign in to the Gakai dashboard
2. Click **Add Account** in the sidebar
3. A QR code appears — scan it with WhatsApp on your phone:
   - WhatsApp → **Settings** → **Linked Devices** → **Link a Device**
4. The account appears in the inbox once pairing completes
5. Repeat for additional phone numbers

Sessions persist across restarts. If a session expires, the dashboard will prompt you to re-scan.

---

## Automation & Webhooks

Gakai includes a built-in automation gateway compatible with n8n and any HTTP webhook consumer.

**How it works:**

- The private provider sends incoming WhatsApp events to Gakai via a signed internal webhook
- Gakai verifies the HMAC-SHA512 signature before processing
- Gakai forwards normalized events to any registered automation subscriber URL

**Registering a webhook from the dashboard:**

1. Go to **Settings → Automations**
2. Enter your webhook URL (must be HTTPS for external endpoints)
3. Save — Gakai will POST incoming message events to that URL in real time

**n8n example payload shape:**

```json
{
  "event": "message",
  "session": "my-account",
  "payload": {
    "id": "...",
    "from": "1234567890@c.us",
    "body": "Hello from WhatsApp",
    "timestamp": 1700000000,
    "type": "chat"
  }
}
```

Gakai normalizes provider payloads before forwarding — your automation consumer never sees raw provider-specific internals.

---

## Operations & Maintenance

### Check status

```sh
docker compose ps
```

### View live logs

```sh
# Gakai application logs
docker compose logs -f home

# Provider runtime logs
docker compose logs -f provider
```

### Health checks

```sh
# Is Gakai running?
curl http://gakai.localhost:3000/healthz
# → {"ok":true,"service":"gakai"}

# Is the private provider reachable?
curl http://gakai.localhost:3000/readyz
# → {"ok":true} or error details if provider is down
```

### Restart after a code change

```sh
docker compose up -d --build
```

### Stop all services

```sh
docker compose down
```

### Upgrade Gakai

```sh
git pull --ff-only origin main
./scripts/gakai-up.sh
```

The launcher rebuilds the image and restarts services. Your data in `home-data/` and `sessions/` is preserved.

---

## Environment Variables

All variables are optional. Safe defaults are set automatically by the launcher.

| Variable | Default | Description |
|---|---|---|
| `GAKAI_PORT` | `3000` | Host port Gakai listens on |
| `GAKAI_BIND_ADDRESS` | `0.0.0.0` | Network interface to bind (`127.0.0.1` for local-only) |
| `GAKAI_PUBLIC_HOST` | `gakai.localhost` | Hostname used in generated self-links |
| `GAKAI_PUBLIC_URL` | _(auto-derived)_ | Override the full public-facing URL |
| `GAKAI_PROVIDER_API_KEY` | _(auto-generated)_ | Internal credential between Gakai and its provider |
| `GAKAI_PROVIDER_WEBHOOK_SECRET` | _(auto-generated)_ | HMAC key for verifying provider webhook payloads |

> **Do not edit `.env` manually.** The launcher manages it. Secrets are auto-generated with `openssl rand -hex 32` on first run and are never exposed to the browser or logs.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                      Browser                         │
│         (your computer / phone / tablet)             │
└──────────────────────┬───────────────────────────────┘
                       │ HTTP / HTTPS (your reverse proxy)
                       ▼
┌──────────────────────────────────────────────────────┐
│                   Gakai  :3000                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  server.mjs  ·  public/app.js  ·  styles.css    │ │
│  ├─────────────────────────────────────────────────┤ │
│  │  Authentication   (scrypt, session tokens)      │ │
│  │  Account manager  (WhatsApp session lifecycle)  │ │
│  │  Message shaping  (normalize provider payloads) │ │
│  │  Media relay      (cached, ranged)              │ │
│  │  Automation       (HMAC-verified webhooks)      │ │
│  │  SQLite state     (WAL, durable)                │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────┬───────────────────────────────┘
                       │ Docker private network
                       │ (no host port — never browser-accessible)
                       ▼
┌──────────────────────────────────────────────────────┐
│             gakai-provider  (internal)               │
│  Private WhatsApp runtime · Sessions · QR lifecycle  │
└──────────────────────────────────────────────────────┘
```

**Key design principles:**

- The browser calls **only** `/api/app/*` and `/api/integrations/v1/*` — never the provider directly
- Provider payloads are **normalized at the server boundary** before any data reaches the UI
- The internal provider is on a **Docker private network** with no exposed host port
- The provider adapter is designed to be **replaceable** without changing the Gakai API or UI

---

## Security

| Concern | How Gakai handles it |
|---|---|
| Admin password storage | scrypt + random salt, stored as hex hash in `home-data/` |
| Session tokens | 32-byte cryptographically random tokens, `HttpOnly; SameSite=Strict` cookies |
| Password comparison | `timingSafeEqual` to prevent timing attacks |
| Provider credential | Auto-generated 256-bit hex key; never sent to the browser |
| Webhook authenticity | HMAC-SHA512 signature on every provider event |
| Media relay | Only paths under `/api/files/` are relayed; SSRF guard on external URL fetches |
| SSRF protection | `safePublicUrl` resolves hostnames and blocks private/RFC-1918 addresses |
| Provider isolation | Private Docker network; no host port on the provider container |

---

## Private Data

The following paths contain runtime secrets and user data. They are excluded from Git and the Docker build context automatically:

| Path | Contents | Committed? |
|---|---|---|
| `.env` | Auto-generated internal credentials | Never |
| `sessions/` | WhatsApp session files (pairing state) | Never |
| `home-data/` | Admin hash, app state, SQLite database | Never |

**Do not share, commit, or back these up to any public or cloud storage.**

---

## Development

### Validate JavaScript without installing Node locally

```sh
docker compose run --rm --no-deps home node --check /app/public/app.js
```

### Rebuild after editing server or frontend code

```sh
docker compose up -d --build
```

### Run a syntax check on server.mjs

```sh
docker compose run --rm --no-deps home node --check /app/server.mjs
```

### Working with fixtures

Sanitized provider payload fixtures live in `test/fixtures/providers/waha/`. Use them to develop and test message rendering without a live WhatsApp session.

```sh
ls test/fixtures/providers/waha/
```

> Fixtures must contain **sanitized data only**. Never add real phone numbers, names, message content, session files, or credentials.

### Project structure

```
gakai-zap/
├── server.mjs              # Node HTTP server, auth, provider proxy, message shaping
├── public/
│   ├── app.js              # Vanilla browser application
│   ├── styles.css          # Dashboard styles
│   └── index.html          # Entry document
├── src/
│   ├── api/                # Planned provider-neutral API layer
│   ├── domain/             # Planned domain model
│   ├── providers/waha/     # Planned provider adapter
│   ├── storage/            # Planned storage abstraction
│   ├── realtime/           # Planned SSE/WebSocket layer
│   └── worker/             # Planned background worker
├── deploy/
│   ├── compose/            # Docker Compose deployment artifacts
│   └── standalone/         # Planned single-image distribution
├── test/
│   └── fixtures/           # Sanitized provider payload fixtures
├── scripts/
│   └── gakai-up.sh         # One-command launcher
├── docker-compose.yml      # Local Gakai runtime
└── Dockerfile              # Application image (Node 22 Alpine)
```

---

## Tech Stack

- **Runtime:** Node.js 22 on Alpine Linux (minimal Docker image)
- **Server:** Native `node:http` — no framework, no external HTTP dependencies
- **Storage:** `node:sqlite` in WAL mode — durable, zero-dependency embedded database
- **Auth:** `node:crypto` — scrypt password hashing, HMAC session tokens, timing-safe comparison
- **Frontend:** Vanilla JavaScript, zero build step, zero bundler
- **Deployment:** Docker Compose with a private internal network for the provider

---

## Roadmap

Planned work in priority order:

1. **Provider-neutral message model** — stable Gakai domain types, fixture-based rendering tests, clean adapter interface
2. **Durable event storage** — signed webhook ingestion, idempotency, normalized update handling with ordering guarantees
3. **Real-time browser push** — live updates via Gakai-controlled SSE or WebSocket endpoints, replacing the polling fallback
4. **Production topology** — Postgres, object storage, queue, health-monitored multi-instance setup
5. **One-image distribution** — single `docker pull gakai` public release; customers configure only Gakai, not the internal runtime
6. **CI and signed releases** — automated compatibility review, versioned image builds, changelog generation

---

## Contributing

Contributions are welcome. Please follow these guidelines:

1. **Fork** the repository and create a feature branch:
   ```sh
   git checkout -b feature/your-feature-name
   ```
2. **Read the architecture rules** in this README before making changes — especially the provider boundary and browser isolation requirements
3. **Make focused commits** with short imperative messages (`Add unread badge`, `Fix media relay for voice notes`)
4. **Add sanitized fixtures** for any change that depends on provider payload shapes
5. **Validate** your JavaScript inside the container before opening a PR:
   ```sh
   docker compose run --rm --no-deps home node --check /app/public/app.js
   ```
6. **Open a pull request** against `main` — describe what changed and why

**Do not commit:** `.env`, `sessions/`, `home-data/`, real WhatsApp payloads, phone numbers, or credentials of any kind.

---

## License

MIT © [Tadeu Banzato](https://github.com/tadeubanzato)

---

<details>
<summary>Search keywords</summary>

self-hosted whatsapp · whatsapp web client · whatsapp dashboard · whatsapp workspace · whatsapp self-hosted server · whatsapp open source · whatsapp multi-account · whatsapp docker · whatsapp docker compose · whatsapp automation · whatsapp webhook · whatsapp n8n · whatsapp api gateway · whatsapp session manager · whatsapp inbox · whatsapp team dashboard · whatsapp business open source · self-hosted messaging · gakai

</details>
