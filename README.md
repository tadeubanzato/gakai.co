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
- [Requirements](#requirements)
- [Installation](#installation)
- [Accessing Gakai](#accessing-gakai)
- [Adding WhatsApp Accounts](#adding-whatsapp-accounts)
- [Automation & n8n Integration](#automation--n8n-integration)
- [Reverse Proxy & HTTPS](#reverse-proxy--https)
- [Environment Variables](#environment-variables)
- [Operations](#operations)
- [Architecture](#architecture)
- [Security](#security)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## How it works

Gakai runs as **two Docker containers** managed by a single `docker compose up` command:

| Container | What it does | Exposed? |
|---|---|---|
| `gakai` | Dashboard, authentication, API, automation gateway | Yes — port 3000 |
| `gakai-provider` | WhatsApp protocol engine, sessions, QR lifecycle | No — private network only |

The provider container is an internal implementation detail. It sits on a private Docker network with no host port — it is never reachable from a browser or the internet. Gakai is the only thing users interact with.

> **Dependency note:** The current provider runtime is [WAHA](https://waha.devlike.pro) (WhatsApp HTTP API), which Docker Compose pulls automatically when you start Gakai. You do not need to install or configure WAHA separately — it starts as a private background service. The roadmap goal is to bundle the WhatsApp engine directly into a single Gakai image so no external pull is required.

---

## Features

| Feature | Status |
|---|---|
| Multi-account WhatsApp sessions | ✅ Live |
| QR-code pairing flow in browser | ✅ Live |
| Text, image, audio, video, document messages | ✅ Live |
| Group chats with sender identity | ✅ Live |
| Unread counts and bold unread state | ✅ Live |
| Media relay (images, documents, voice notes) | ✅ Live |
| Open Graph and Instagram link previews | ✅ Live |
| n8n one-click automation connect | ✅ Live |
| Webhook automation subscriptions | ✅ Live |
| scrypt password hashing (salted) | ✅ Live |
| HMAC-SHA512 provider webhook verification | ✅ Live |
| SQLite state in WAL mode | ✅ Live |
| `/healthz` and `/readyz` endpoints | ✅ Live |
| Provider-neutral architecture | 🔄 In progress — provider transport is now behind an internal adapter; message and event normalization migration continues |
| SSE / WebSocket real-time push | ✅ Live — authenticated SSE plus WebSocket typing/presence |
| Single-image distribution (no external pull) | 🔄 In progress — a combined-image runtime is available for validation; registry publishing remains to be added |

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Docker Engine | 24+ | or Docker Desktop |
| Docker Compose plugin | v2+ | bundled with Docker Desktop |
| `openssl` | any | generates secrets on first run |
| Port 3000 | free | configurable via `GAKAI_PORT` |

No Node.js required on the host. Everything runs inside the containers.

### Combined-image preview

The default installation uses the proven two-container setup. To validate the
combined Gakai image, set `GAKAI_SINGLE_IMAGE=1` when starting. It runs the
provider privately inside the Gakai container and exposes only Gakai's port:

```sh
GAKAI_SINGLE_IMAGE=1 ./scripts/gakai-up.sh
```

This is the runtime foundation for a future published `docker pull` image. The
repository does not yet publish or sign a registry image.

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
4. Builds the Gakai image and starts both containers
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
2. Click **Add Account** in the sidebar
3. Scan the QR code with WhatsApp on your phone:
   - WhatsApp → **Settings** → **Linked Devices** → **Link a Device**
4. The account appears in the inbox once pairing completes
5. Repeat for each additional phone number

Sessions persist across restarts. If a session expires, the dashboard prompts you to re-scan.

---

## Automation & n8n Integration

Gakai includes a built-in automation gateway. Incoming WhatsApp messages are forwarded in real time to any webhook URL you register — including n8n.

### Connect n8n in one click

1. In Gakai, open an account and go to **Automations → Connect n8n**
2. Paste your n8n instance URL and API key
3. Gakai automatically creates the credentials and a starter workflow in n8n
4. Incoming messages start flowing to your n8n workflow immediately

Works with both self-hosted n8n and n8n Cloud.

### Manual webhook

1. Go to **Settings → Automations**
2. Enter any HTTPS webhook URL
3. Save — Gakai POSTs normalized events to that URL in real time

### Example payload

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

Gakai normalizes all provider payloads before forwarding — your automation never sees provider-specific internals.

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

> If you use n8n auto-connect from a publicly accessible Gakai instance, set `GAKAI_PUBLIC_URL=https://gakai.example.com` so n8n can reach Gakai's webhook endpoint.

---

## Environment Variables

All variables are optional. The launcher sets safe defaults automatically.

| Variable | Default | Description |
|---|---|---|
| `GAKAI_PORT` | `3000` | Host port Gakai listens on |
| `GAKAI_BIND_ADDRESS` | `0.0.0.0` | Network interface (`127.0.0.1` for local-only) |
| `GAKAI_PUBLIC_URL` | _(auto-derived)_ | Full public URL — set this when behind a reverse proxy |
| `GAKAI_PROVIDER_API_KEY` | _(auto-generated)_ | Internal credential between Gakai and its provider |
| `GAKAI_PROVIDER_WEBHOOK_SECRET` | _(auto-generated)_ | HMAC key for verifying provider webhook payloads |

> Do not edit `.env` manually. The launcher manages it. Secrets are auto-generated with `openssl rand -hex 32` on first run and are never exposed to the browser or logs.

---

## Operations

### Check container status

```sh
docker compose ps
```

### View logs

```sh
docker compose logs -f home      # Gakai application
docker compose logs -f provider  # WhatsApp engine
```

### Health checks

```sh
curl http://localhost:3000/healthz
# → {"ok":true,"service":"gakai"}

curl http://localhost:3000/readyz
# → {"ok":true} or error details if the provider is unreachable
```

### Stop

```sh
docker compose down
```

### Upgrade

```sh
git pull --ff-only origin main
./scripts/gakai-up.sh
```

The launcher rebuilds the Gakai image and restarts both containers. Data in `home-data/` and `sessions/` is preserved.

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
│  │  Account manager   WhatsApp session lifecycle     │   │
│  │  Message shaping   normalize provider payloads    │   │
│  │  Media relay       cached · ranged responses      │   │
│  │  Automation        HMAC-verified webhook gateway  │   │
│  │  SQLite state      WAL mode · durable             │   │
│  └──────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────┘
                        │  Docker private network
                        │  (no host port — never browser-accessible)
                        ▼
┌─────────────────────────────────────────────────────────┐
│               gakai-provider  (internal only)           │
│     WhatsApp protocol · Sessions · QR lifecycle         │
│     Pulled automatically by Docker Compose              │
└─────────────────────────────────────────────────────────┘
```

**Design rules:**

- The browser talks only to Gakai — never to the provider directly
- Provider payloads are normalized at the server boundary before reaching the UI
- The provider sits on a private Docker network with no host port
- The provider adapter is designed to be swapped without changing the Gakai API or UI

---

## Security

| Concern | How Gakai handles it |
|---|---|
| Password storage | scrypt + random salt, stored as hex hash — never plaintext |
| Session tokens | 32-byte cryptographically random, `HttpOnly; SameSite=Strict` cookie |
| Timing attacks | `timingSafeEqual` for all credential comparisons |
| Internal credential | Auto-generated 256-bit hex key, never sent to browser or logs |
| Provider webhook | HMAC-SHA512 signature verified on every inbound event |
| Media relay | Only `/api/files/` paths relayed; SSRF guard on external fetches |
| Provider isolation | Private Docker network, no host port on the provider container |

---

## Development

### Validate JavaScript (no local Node needed)

```sh
docker compose build home
docker compose run --rm --no-deps home node --check /app/public/assets/app.js
docker compose run --rm --no-deps home node --check /app/server.mjs
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

Sanitized provider payload fixtures live in `test/fixtures/providers/waha/`. Use them to develop message rendering without a live WhatsApp session. Never add real phone numbers, names, message content, or credentials.

### Project structure

```
gakai.co/
├── server.mjs              # Node HTTP server — auth, API, provider proxy, automation
├── client/
│   ├── app.jsx             # React browser application
│   └── chat.jsx            # Conversation view
├── public/
│   ├── assets/app.js       # esbuild output of client/ (generated, gitignored)
│   ├── styles.css          # Dashboard styles
│   └── index.html          # Entry document
├── src/
│   ├── api/                # Planned provider-neutral API layer
│   ├── domain/             # Message/chat normalization (fixture-tested)
│   ├── providers/waha/     # Provider adapter (designed to be swapped)
│   ├── storage/            # Planned storage abstraction
│   ├── realtime/           # Realtime extraction target; current endpoints live in server.mjs
│   └── worker/             # Planned background worker
├── scripts/
│   └── gakai-up.sh         # One-command launcher
├── docker-compose.yml      # Default two-container stack
├── docker-compose.single.yml # Combined-image preview stack
├── Dockerfile              # Default Gakai image (Node 22 Alpine)
├── Dockerfile.single       # Combined Gakai + internal runtime image
└── test/fixtures/          # Sanitized provider payload fixtures
```

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 on Alpine Linux |
| Server | Native `node:http` — no framework |
| Storage | `node:sqlite` in WAL mode — zero external dependency |
| Auth | `node:crypto` — scrypt, HMAC, timing-safe comparison |
| Frontend | React, bundled with esbuild |
| Deployment | Docker Compose — default private-provider stack; combined-image preview available |

---

## Roadmap

1. **Provider-neutral message model** — stable domain types, fixture-based rendering tests, clean adapter interface
2. **Durable event storage** — idempotent webhook ingestion, ordering guarantees
3. **Real-time browser push** — ✅ authenticated SSE and WebSocket typing/presence are live
4. **Production topology** — Postgres, object storage, multi-instance health monitoring
5. **Single-image distribution** — publish and sign the combined Gakai image; one `docker pull`, no external runtime dependency
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
   docker compose build home
   docker compose run --rm --no-deps home node --check /app/public/assets/app.js
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

self-hosted whatsapp · whatsapp workspace · whatsapp dashboard · whatsapp web client · whatsapp docker · whatsapp docker compose · whatsapp multi-account · whatsapp automation · whatsapp webhook · whatsapp n8n integration · whatsapp open source · whatsapp self-hosted server · whatsapp inbox · whatsapp team dashboard · whatsapp api gateway · self-hosted messaging · gakai

</details>
