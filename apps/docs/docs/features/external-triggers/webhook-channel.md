---
title: Webhook channel
sidebar_position: 2
---

# Webhook channel reference

The webhook channel is the generic HTTP ingress for an agent. Any service
that can POST JSON can send the agent a message: Jira, Linear, GitHub
Actions, Zapier, Make, n8n, your own backend, a cron job — anything.

This page is the reference. Read the
[external triggers quickstart](./quickstart) first if you want the
end-to-end story.

## Endpoint

The canonical, externally-callable URL is always:

```
POST https://api.shogo.ai/api/projects/<projectId>/agent-proxy/agent/channels/webhook/incoming
```

It doesn't change when you move the agent between a cloud pod and a paired
VPS — Shogo Cloud handles the routing. You can find this URL pre-filled
in the channel editor in studio.

## Authentication

Send the channel secret in a single header:

```http
X-Webhook-Secret: <your-secret>
```

The secret is configured per-channel. If you don't provide one when
connecting, Shogo generates a 64-character hex secret automatically
(equivalent to `openssl rand -hex 32`).

**No `shogo_sk_*` API key is needed** to call this endpoint. The agent-proxy
lets `/incoming` and `/outbox/<id>` through without a Shogo session;
the channel secret is the only credential a third-party automation tool
needs. A valid `shogo_sk_*` key will still work if you already use one
(no regression), but it no longer has to be sent.

:::tip Rotate the secret
Reconnect with an explicit `secret` to rotate it:
`channel_connect({ type: "webhook", config: { secret: "new-secret" } })`.
Reconnecting **without** a secret keeps the existing one.
:::

## Request body

```json
{
  "message": "Required. The text the agent receives.",
  "senderId": "Optional. Used in the activity log and as the senderId in the agent's context.",
  "senderName": "Optional. Human-readable sender label.",
  "callbackUrl": "Optional. If set, switches to async mode (see below).",
  "metadata": {
    "any": "Optional. Forwarded to the agent unchanged."
  }
}
```

All field names are also accepted as `snake_case` (`sender_id`, `sender_name`,
`callback_url`) for friendlier wiring from Jira / Zapier templates.

## Two reply modes

### Sync (default)

If `callbackUrl` is omitted, the request blocks until the agent finishes
its tool loop and returns the reply inline:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "reply": "Done. PR opened at https://github.com/...", "correlationId": "webhook-1748..." }
```

The runtime times out the reply at **120 seconds**. When the timeout fires,
the response is `202` with a `correlationId` and `outboxUrl` — see
[Polling the outbox](#polling-the-outbox-timeout-fallback) below.
For long-running jobs, use async mode.

### Async (recommended for long jobs)

Pass `callbackUrl`. The server returns `202` immediately and POSTs the
reply to that URL when the agent finishes:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "status": "accepted", "correlationId": "webhook-1748..." }
```

The callback POST looks like:

```http
POST <callbackUrl>
Content-Type: application/json

{
  "reply": "...",
  "correlationId": "webhook-1748..."
}
```

Configure default callback headers per channel in the studio editor
(`callbackHeaders` field, JSON-encoded) if your callback URL requires auth.

## Polling the outbox (timeout fallback)

When a sync request times out, the response is:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "status": "pending",
  "correlationId": "webhook-1748...",
  "outboxUrl": "https://api.shogo.ai/api/projects/.../agent-proxy/agent/channels/webhook/outbox/webhook-1748..."
}
```

The agent's late reply lands in the outbox. Poll with:

```http
GET <outboxUrl>
X-Webhook-Secret: <your-secret>
```

```json
{ "messages": ["The PR is open at https://github.com/..."] }
```

The first successful GET drains and removes the entry. Outbox entries
expire after 24 hours; each correlationId holds at most 100 messages.

Some integrations that can't accept an inbound POST can also use the outbox
for long-polling — send a message, then GET the outbox until messages appear.

## Status codes

| Code | Meaning |
| --- | --- |
| `200` | Sync mode succeeded; body contains `reply` and `correlationId`. |
| `202` | Accepted (async mode or sync timeout); body contains `correlationId` and optionally `outboxUrl`. |
| `400` | Missing or non-string `message`. |
| `401` | Bad or missing `X-Webhook-Secret`. |
| `503` (with `error.code: "instance_offline"`) | Project is pinned to a paired machine that's currently offline. See [external triggers quickstart](./quickstart). |
| `503` (with `error.code: "agent_start_failed"`) | Cloud-pod runtime failed to cold-start. Retryable. |

## Health and activity

The channel exposes two extra endpoints under the same agent-proxy path —
**these require a Shogo session** (they leak message previews or run turns):

- `GET .../agent/channels/webhook/health` — `{ connected, hasSecret, messageCount }`.
- `GET .../agent/channels/webhook/activity` — last 50 inbound + outbound events,
  used by the studio Channels editor to show "last triggered" timestamps.

## Example curl

```bash
curl -X POST \
  "https://api.shogo.ai/api/projects/<projectId>/agent-proxy/agent/channels/webhook/incoming" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message": "Fix bug PROJ-123"}'
```

## See also

- [External triggers quickstart](./quickstart)
- [`packages/agent-runtime/src/channels/webhook.ts`](https://github.com/shogo-ai/shogo/blob/main/packages/agent-runtime/src/channels/webhook.ts) — the source of truth.
