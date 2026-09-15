---
title: Reference
sidebar_position: 7
---

# Embedded chat reference

## Client

`createChatClient({ apiUrl, projectId, publishableKey, transport, visitor })`
returns a client with `send(text)`, `stop()`, `identify(visitor)`,
`getSnapshot()`, and `on(event, listener)`.

`transport` is `persona` by default or `runtime` for the live WebChat channel.
Use `visitorId` or a custom storage adapter when a visitor must keep the same
conversation across reloads.

## Hosted endpoints

- `POST /api/chat/turn` — ProjectAgent persona stream.
- `GET|POST /api/projects/:projectId/agent-proxy/agent/channels/webchat/*` —
  runtime session, history, message, events, config, and stop operations.
- `GET /embed/v1/chat.js` — script-tag loader.
- `GET /embed/v1/index.html` — isolated hosted chat surface.

## Common errors

- `401` — missing, expired, or malformed key/session.
- `403` — the publishable key origin or project does not match.
- `404` — runtime transport has no connected WebChat channel.
- `429` — visitor, origin, or channel rate limit reached.

Never use a `shogo_sk_*` key in browser code. Rotate it immediately if one is
exposed.
