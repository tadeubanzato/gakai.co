---
name: start-gakai
description: Load the complete Gakai project context and engineering workflow. Use when starting work in the Gakai repository, implementing UI or backend features, changing the provider integration, improving the inbox, planning storage or realtime work, preparing deployment, or reviewing changes against the public single-product Docker end state.
---

# Start Gakai

## Product mission

Build Gakai as a professional WhatsApp workspace that users install as one Gakai product. Gakai owns the dashboard, API, authentication, event handling, data model, and future release process. The upstream WhatsApp provider is an internal implementation detail, never a separate customer-facing install.

Do not describe Gakai as WAHA Home. Use Gakai in visible copy, images, container names, documentation, and product decisions. Keep the provider adapter isolated so it can be replaced later.

## Read this first

- Work from `/home/tbanzato/gakai`, not the legacy `/home/tbanzato/waha` directory.
- The current branch may be a feature branch. Check `git branch --show-current` and `git status --short` before editing.
- Read `server.mjs`, `public/app.js`, `public/styles.css`, `docker-compose.yml`, and the relevant tests or fixtures before making a change.
- Treat `src/` as the target architecture. It currently contains scaffolding; do not claim the planned modules already implement production behavior.
- Read this skill completely before making product-wide decisions.

## Current verified runtime

- Dashboard URL: `http://gakai.localhost:3000`.
- Compose project: `/home/tbanzato/gakai/docker-compose.yml`.
- Public application container: `gakai`.
- Private provider container: `gakai-provider`; it has no host port. The current provider image is upstream WAHA and remains internal during the transition.
- Persisted local runtime state: `.env`, `sessions/`, and `home-data/`. These are intentionally ignored by Git and must never be committed, copied to fixtures, logged, or exposed in browser code.
- `/home/tbanzato/waha` is a rollback backup only. Do not start, delete, or edit it unless the user explicitly requests a controlled rollback or retirement.

## Current codebase

- `server.mjs`: Node HTTP application, authentication, provider REST proxy, media relay, message shaping, account/chat/message endpoints.
- `public/app.js`: vanilla browser application. It has accumulated compatibility wrappers around `render`, `openChat`, and `send`; preserve wrapper order and confirm the final override when editing behavior.
- `public/styles.css`: dashboard styles.
- `public/index.html`: entry document.
- `docker-compose.yml`: local Gakai runtime with a private provider and a public Home API/UI service.
- `src/api`, `src/domain`, `src/providers/waha`, `src/storage`, `src/realtime`, `src/worker`: planned provider-neutral architecture boundaries.
- `packages/provider-runtime`: future bundled provider runtime boundary.
- `deploy/standalone` and `deploy/compose`: future one-product deployment artifacts.
- `test/fixtures/providers/waha`: sanitized payload fixtures only. Never store real chat content, phone numbers, credentials, session files, or media.

## Product and architecture rules

1. Keep the browser isolated from provider credentials and direct provider access. The browser talks only to Gakai endpoints.
2. Normalize provider payloads at the backend boundary. The UI consumes a stable Gakai message/event model, not raw provider-specific objects.
3. Render every supported message type deliberately. For unknown structured payloads, show a safe useful fallback rather than an empty bubble or raw object/source text.
4. Preserve captions, sender identity, timestamps, media semantics, and accessible labels when adding UI cards.
5. Design every new backend feature so `src/providers/waha` can eventually be swapped for another provider adapter.
6. Do not introduce a second customer-managed provider installation. Gakai owns configuration, health checks, storage, and upgrades.
7. Do not destructively stop containers, remove volumes, delete sessions, reset Git, or overwrite user data without explicit user authorization and a verified target.

## Inbox quality bar

The inbox is the active product focus. Maintain fast and clear conversation scanning:

- Show unread counts and a strong unread state until the reader opens a chat.
- Make names/group names, previews, sender context, media, message status, and time easy to distinguish.
- Preserve scroll position when paging older messages or media changes layout.
- Keep mobile behavior usable.
- Avoid automatic request fan-out; provider calls can cause browser-backed engines to become slow.
- Support text, media, documents, link previews, contact cards, group senders, mentions, and safe fallbacks. Add fixtures before extending structured rendering.

## Planned foundations

Implement in this order unless the user explicitly reprioritizes:

1. Complete the provider-neutral message/event model and fixture-based rendering tests.
2. Add signed provider webhook ingestion, idempotency, durable event/message storage, and normalized update handling.
3. Deliver live browser updates from the stored event stream through Gakai-controlled SSE or WebSocket endpoints.
4. Later: production Postgres/object storage/queue topology, one-image or one-version Gakai distribution, CI, signed releases, and an agentic compatibility-review workflow that proposes reviewed changes rather than silently publishing them.

The future public release must let users pull Gakai only. Internally it may contain provider components, but customers must not configure or expose them separately.

## Engineering workflow

1. Inspect the exact current code path and check the working tree before changing files.
2. Make the smallest coherent implementation. Preserve unrelated user changes.
3. Add or update sanitized fixtures/tests for behavior that depends on provider payloads.
4. Validate browser JavaScript inside the application image because the host may not have Node: `docker compose run --rm --no-deps home node --check /app/public/app.js`.
5. Rebuild and restart the changed service: `docker compose up -d --build`.
6. Verify the live app through `http://gakai.localhost:3000`; inspect service status/logs when a change affects runtime behavior.
7. Review `git diff --check` and `git status`. Commit focused changes on the active feature branch and push only after validation.

## Git and release hygiene

- Repository: `git@github.com:tadeubanzato/gakai-zap.git`.
- Default branch: `main`. Use focused `feature/...` branches for work.
- Never stage `.env`, `sessions/`, `home-data/`, generated media, credentials, or real payload captures.
- Use concise imperative commit messages, for example `Highlight unread conversations`.
- Do not merge, tag, publish a public image, or alter release automation unless the user explicitly asks.

## Decision guidance

Prefer a safe incremental migration over a rewrite. When current legacy wrappers make a change fragile, document the dependency and move behavior toward the planned modules rather than adding unbounded new global wrappers. State assumptions, verify live behavior after changes, and clearly distinguish completed behavior from the future Gakai architecture.

