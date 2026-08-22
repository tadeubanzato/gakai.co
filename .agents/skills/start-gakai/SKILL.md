---
name: start-gakai
description: Load the complete Gakai project context and engineering workflow. Use when starting work in the Gakai repository, implementing UI or backend features, changing the provider integration, improving the inbox, planning storage or realtime work, preparing deployment, or reviewing changes against the public single-product Docker end state.
---

# Start Gakai

## Product mission

Build Gakai as a professional WhatsApp workspace that users install as one Gakai product. Gakai owns the dashboard, API, authentication, event handling, data model, and future release process. The upstream WhatsApp provider is an internal implementation detail, never a separate customer-facing install.

Do not describe Gakai as WAHA Home. Use Gakai in visible copy, images, container names, documentation, and product decisions. Keep the provider adapter isolated so it can be replaced later.

## Read this first

- Before reading code or taking any project action, synchronize the current branch: run `git status --short`, `git fetch origin --prune`, then—only if the working tree is clean—`git pull --ff-only origin $(git branch --show-current)`. Never switch branches, merge, rebase, stash, or overwrite local work automatically. If fast-forwarding is impossible or the tree is dirty, report it and wait for direction.
- Read `server.mjs`, `client/app.jsx`, `client/chat.jsx`, `public/styles.css`, `docker-compose.yml`, and the relevant tests or fixtures before making a change.
- During startup, read `references/provider-api.md` when it exists for the current official provider links, verified payload notes, and adapter boundary rules. Its absence is never a startup blocker: note it briefly, continue with the checked-in code and compose configuration, and create or repair the sanitized reference before any provider-integration change. Do not use a compound inspection command that fails just because this optional file is absent.
- Treat `src/` as the target architecture. It currently contains scaffolding; do not claim the planned modules already implement production behavior.
- Read this skill completely before making product-wide decisions.

## Current verified runtime

- Dashboard URL: `http://localhost:3000` by default; the actual host and port depend on where Docker Compose is running and which `GAKAI_PORT` is set. Do not hardcode a specific hostname.
- Start Gakai from the repository root with `./scripts/gakai-up.sh`. Set `GAKAI_PORT` or `GAKAI_BIND_ADDRESS` as needed.
- Public application container: `gakai`.
- Private provider container: `gakai-provider`; it has no host port. The current provider image is upstream WAHA and remains internal during the transition.
- Persisted local runtime state: automatically generated `.env`, `sessions/`, and `home-data/`. These are intentionally ignored by Git and must never be committed, copied to fixtures, logged, or exposed in browser code.

## Current codebase

- `server.mjs`: Node HTTP application, authentication, provider REST proxy, media relay, message shaping, account/chat/message endpoints.
- `client/app.jsx` / `client/chat.jsx`: React browser application, bundled with esbuild (`scripts/build-client.mjs`) into the gitignored `public/assets/app.js`, which `public/index.html` loads.
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

## Provider API references

- For any provider integration, payload, event, capability, engine, or version work, read `references/provider-api.md` before changing code. If it is missing, first create a concise sanitized replacement that links to official provider documentation and records the adapter boundary; then verify the exact capability in the official documentation at implementation time.
- Treat those links and payload notes as internal adapter material only. Keep Gakai browser endpoints, UI copy, customer documentation, and configuration provider-neutral.
- Re-check the official documentation at implementation time: provider capabilities vary by engine and may change between releases.

## Deployment model — current and future

### Current (two-container, approved for now)

`docker compose up` starts two containers:

- `gakai` — built from this repo's Dockerfile; the only browser-facing service
- `gakai-provider` — pulls `devlikeapro/waha` from Docker Hub; handles the WhatsApp protocol, sessions, and QR lifecycle; has no host port and is never exposed to the browser

This is the approved distribution model for the current phase. Users clone the repo and run `./scripts/gakai-up.sh`. Docker Compose pulls the WAHA provider image automatically alongside the Gakai build. This is intentional and correct right now.

Do not treat the WAHA provider image as something to hide or remove. It is a declared, versioned dependency, the same way a Node app declares npm packages.

### Future (single-image target)

The end state is one public image: `docker pull gakai`. Customers configure only Gakai; the WhatsApp engine is bundled inside. This requires either embedding the provider runtime into the Gakai image or replacing it with a fully open WhatsApp library (e.g. `@whiskeysockets/baileys`). The `src/providers/waha` adapter boundary exists specifically to make this swap possible without changing the Gakai API or UI.

Do not attempt the single-image migration unless the user explicitly requests it.

## Planned foundations

Implement in this order unless the user explicitly reprioritizes:

1. Complete the provider-neutral message/event model and fixture-based rendering tests.
2. Add signed provider webhook ingestion, idempotency, durable event/message storage, and normalized update handling.
3. Deliver live browser updates from the stored event stream through Gakai-controlled SSE or WebSocket endpoints.
4. Later: production Postgres/object storage/queue topology, single-image Gakai distribution (provider bundled in), CI, signed releases, and an agentic compatibility-review workflow that proposes reviewed changes rather than silently publishing them.

## Engineering workflow

1. Synchronize the current branch using the required safe fast-forward workflow, then inspect the exact current code path before changing files.
2. Make the smallest coherent implementation. Preserve unrelated user changes.
3. Add or update sanitized fixtures/tests for behavior that depends on provider payloads.
4. Validate browser JavaScript inside the application image because the host may not have Node: `docker compose build home && docker compose run --rm --no-deps home node --check /app/public/assets/app.js` (`docker compose build` runs esbuild on `client/*.jsx`, catching JSX/bundling errors; `node --check` then validates the compiled, JSX-free bundle).
5. Run the test suite: `docker build --target test -t gakai-test . && docker run --rm gakai-test`. The final runtime image intentionally ships without `package.json`/`test/` (lean production image), so tests run against the Dockerfile's `test` stage — a discardable stage built on top of the already-`npm ci`'d frontend stage, never referenced by the shipped image. Do not use `docker compose run ... npm test` — it fails with a missing `package.json` against the runtime image.
6. Rebuild and restart the changed service: `docker compose up -d --build`.
7. Verify the live app at the URL printed by the launcher (`http://localhost:3000` unless overridden); inspect service status/logs when a change affects runtime behavior.
8. Review `git diff --check` and `git status`. Commit focused changes on the active feature branch and push only after validation.

## Git and release hygiene

- Repository: `git@github.com:tadeubanzato/gakai.co.git`.
- Default branch: `main`. Use focused `feature/...` branches for work.
- Never stage the automatically generated `.env`, `sessions/`, `home-data/`, generated media, credentials, or real payload captures.
- Use concise imperative commit messages, for example `Highlight unread conversations`.
- Do not merge, tag, publish a public image, or alter release automation unless the user explicitly asks.

## Decision guidance

Prefer a safe incremental migration over a rewrite. When current legacy wrappers make a change fragile, document the dependency and move behavior toward the planned modules rather than adding unbounded new global wrappers. State assumptions, verify live behavior after changes, and clearly distinguish completed behavior from the future Gakai architecture.
