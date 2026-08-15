# Provider API reference

Use this reference when touching the current private WhatsApp provider adapter, its payloads, webhooks, engine capability, or compatibility checks. It is internal engineering context, not customer-facing Gakai documentation.

## Official documentation

- [API overview and Swagger](https://waha.devlike.pro/swagger/)
- [Sessions and QR lifecycle](https://waha.devlike.pro/docs/how-to/sessions/)
- [Chats, overview payloads, and read state](https://waha.devlike.pro/docs/how-to/chats/)
- [Send text, media, contacts, and seen state](https://waha.devlike.pro/docs/how-to/send-messages/)
- [Receive messages, webhooks, and WebSockets](https://waha.devlike.pro/docs/how-to/receive-messages/)
- [Events and webhook configuration](https://waha.devlike.pro/docs/how-to/events/)
- [Engine capability matrix](https://waha.devlike.pro/docs/how-to/engines/)
- [Runtime configuration](https://waha.devlike.pro/docs/how-to/config/)
- [Provider changelog](https://waha.devlike.pro/docs/overview/changelog/)

## Current Gakai boundary

- The browser calls only `/api/app/*` and `/api/integrations/v1/*`; it never calls the provider or receives provider credentials.
- `server.mjs` is the current adapter boundary. Normalize provider payloads there before returning data to the browser.
- The provider is private on the Docker network. Gakai automatically persists its internal credential in `.env`; the administrator credential is instead stored as a salted hash in `home-data`. Its runtime-specific environment variables remain compatibility details until the adapter/transport replacement is complete.
- Never paste real credentials, phone numbers, message text, session files, media, or raw production payloads into Git, fixtures, logs, prompts, or the skill.

## Verified payload and endpoint notes

- `GET /api/{session}/chats/overview` returns `id`, `name`, `picture`, `lastMessage`, and engine-specific `_chat` data.
- With the current WEBJS runtime, unread count is `_chat.unreadCount`, not top-level `unreadCount`. Normalize defensively because engines may shape this differently.
- Read a user-opened chat with `POST /api/{session}/chats/{chatId}/messages/read`; do not mark a conversation read merely because it was polled.
- Send text through `POST /api/sendText` with session, chat ID, and text. Keep this behind Gakai authorization and validation.
- Session lifecycle uses `/api/sessions`, session start/restart endpoints, and QR authorization under `/api/{session}/auth/qr`.
- Prefer provider events/webhooks or WebSockets for scalable inbound updates. The current 10-second inbox poll is a transitional fallback, not the target realtime design.

## Integration procedure

1. Verify endpoint support for the configured engine in the official capability matrix.
2. Read the current upstream schema or a sanitized fixture; do not assume a documented field is top-level or stable.
3. Add or update a sanitized fixture and normalize the result into Gakai’s stable domain shape.
4. Keep retries, idempotency, event signatures, and ordering at the Gakai boundary.
5. Validate against the private runtime without printing sensitive payload content.
6. For any provider version update, compare the changelog, Swagger, capability matrix, and Gakai fixtures before changing production behavior.

## Future replacement rule

These links describe the current private provider only. New Gakai domain/API/UI code must not make the provider’s names, environment variables, raw event schemas, or endpoint paths part of a public Gakai contract. The adapter must remain replaceable.
