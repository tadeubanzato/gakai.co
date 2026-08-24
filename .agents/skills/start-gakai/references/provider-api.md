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

## Integration procedure

1. Read the official Baileys documentation and, where useful, its source for the capability or event in question — do not assume a field or event name from memory.
2. Read the current adapter implementation; do not assume a documented shape is what Gakai's adapter actually normalizes.
3. Add or update a sanitized fixture and normalize the result into Gakai's stable domain shape.
4. Keep retries, idempotency, and ordering at the Gakai boundary.
5. Validate against a real WhatsApp connection without printing sensitive payload content.
6. For any Baileys version update, compare the changelog/release notes and Gakai fixtures before changing production behavior.

## Future replacement rule

These links describe the current provider integration only. New Gakai domain/API/UI code must not make the provider's names, environment variables, raw event schemas, or internal shapes part of a public Gakai contract. The adapter must remain replaceable.
