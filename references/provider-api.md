# Provider adapter reference

This document is internal engineering material for the current WAHA adapter.
It is not customer-facing documentation and must not cause the browser to call
the provider directly. Gakai remains the only public product and API.

## Verified sources

- [Sessions](https://waha.devlike.pro/docs/how-to/sessions/)
- [Chats and messages](https://waha.devlike.pro/docs/how-to/chats/)
- [Receiving messages and media](https://waha.devlike.pro/docs/how-to/receive-messages/)
- [Presence](https://waha.devlike.pro/docs/how-to/presence/)
- [Events](https://waha.devlike.pro/docs/how-to/events/)
- [Provider OpenAPI / Swagger](https://waha.devlike.pro/swagger/)

Re-check these primary sources when changing provider behavior: endpoint
availability and payload details vary by WAHA engine and release.

## Boundary rules

- Only `server.mjs` (and future modules under `src/providers/waha`) may call the
  provider. Browser code uses only `/api/app/*` Gakai endpoints.
- Keep provider URL and API key server-side. Do not expose an upstream URL,
  provider API key, session data, raw event body, or media filesystem path to
  browser code, logs, fixtures, or customer documentation.
- Normalize upstream sessions, chats, messages, sender identities, timestamps,
  acknowledgements, media, link previews, contacts, and events before exposing
  them to Gakai consumers.
- Store only sanitized payload examples in `test/fixtures/providers/waha`.

## Current adapter contract

The current runtime uses the `WEBJS` engine unless overridden by
`GAKAI_PROVIDER_ENGINE`. Calls currently used by the Gakai backend include:

- Session lifecycle: `GET/POST /api/sessions`, `GET /api/sessions/{name}`, and
  lifecycle operations for the named session.
- Chat overview: `GET /api/{session}/chats/overview?limit=…`.
- History: `GET /api/{session}/chats/{chatId}/messages` with `limit`, `offset`,
  and `downloadMedia=false` where deferred attachment loading is intended.
- Individual message/media hydration: `GET /api/{session}/chats/{chatId}/messages/{messageId}`
  and managed `/api/files/...` URLs. Relay files through Gakai only.
- Contacts and LID resolution: use the provider contact endpoints internally;
  tolerate resolution failures and retain a safe identifier fallback.
- Presence: `POST /api/{session}/presence` and
  `GET /api/{session}/presence/{chatId}`. Clear a typing state with `paused`.

## Payload notes

- Message timestamps may be seconds, milliseconds, or parseable date strings;
  normalize them to Unix seconds.
- `hasMedia` can be true while `media` is absent when media was not downloaded.
  Preserve the caption/body and render a useful attachment fallback.
- Media URLs often point to the provider's private localhost. Accept only the
  managed `/api/files/` path for the authenticated Gakai relay.
- A message can have raw engine-specific data. Never pass that raw object to the
  browser; map supported fields and provide a safe fallback for unknown types.
- Chat IDs use WhatsApp suffixes such as `@c.us` and `@g.us`; URL-encode IDs and
  message IDs when composing provider paths.

## Change checklist

1. Verify the exact endpoint, payload, engine support, and version in the
   official source above.
2. Add or update a sanitized fixture before changing normalization or rendering.
3. Preserve Gakai's provider-neutral public model and accessible UI fallback.
4. Validate inside the application image and verify the live Gakai URL.
