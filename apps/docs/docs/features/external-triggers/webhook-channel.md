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

Send **both** of the following:

1. **Cloud auth** (proves the caller has access to the project):

   ```http
   Authorization: Bearer shogo_sk_XXXXXXXXX
   ```

   Mint a key in **Settings → API Keys**. The key must belong to a user
   who is a member of the project's workspace.

2. **Channel auth** (proves the caller is allowed to trigger this channel):

   ```http
   X-Webhook-Secret: <your-secret>
   ```

   Configured per-channel in the studio channel editor under the `secret`
   field. If `secret` is empty, the channel rejects all external requests.

A request that passes cloud auth but fails channel auth gets `401`. A
request that fails cloud auth gets `401` without the channel ever seeing
it.

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

{ "reply": "Done. PR opened at https://github.com/..." }
```

The runtime times out the reply at **120 seconds**. For long-running jobs,
use async mode.

### Async (recommended for long jobs)

Pass `callbackUrl`. The server returns `202` immediately and POSTs the
reply to that URL when the agent finishes:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "status": "accepted", "message": "Reply will be sent to the callback URL." }
```

The callback POST looks like:

```http
POST <callbackUrl>
Content-Type: application/json

{
  "reply": "...",
  "correlationId": "<generated>",
  "metadata": { ... }  // echoed back from the original request
}
```

Configure default callback headers per channel in the studio editor
(`callbackHeaders` field, JSON-encoded) if your callback URL requires
auth.

## Status codes

| Code | Meaning |
| --- | --- |
| `200` | Sync mode succeeded; body contains `reply`. |
| `202` | Async mode accepted; reply will arrive at `callbackUrl`. |
| `400` | Missing or non-string `message`. |
| `401` | Cloud auth or channel secret rejected. |
| `403` | The `shogo_sk_*` key doesn't have access to this project. |
| `503` (with `error.code: "instance_offline"`) | Project is pinned to a paired machine that's currently offline. See [external triggers quickstart](./quickstart). |
| `503` (with `error.code: "agent_start_failed"`) | Cloud-pod runtime failed to cold-start. Retryable. |

## Pulling pending replies (poll mode)

Some integrations (e.g. legacy Zapier "trigger" steps) can't accept an
inbound webhook. Use the outbox endpoint to long-poll instead:

```http
GET /agent/channels/webhook/outbox/<channelId>
```

Returns up to N pending outbound messages addressed to `channelId`.

## Health and activity

The channel exposes two extra endpoints under the same agent-proxy path:

- `GET .../agent/channels/webhook/health` — `{ connected, hasSecret, messageCount }`.
- `GET .../agent/channels/webhook/activity` — last 50 inbound + outbound events,
  used by the studio Channels editor to show "last triggered" timestamps.

Both are also auth-gated.

## See also

- [External triggers quickstart](./quickstart)
- [`packages/agent-runtime/src/channels/webhook.ts`](https://github.com/shogo-ai/shogo/blob/main/packages/agent-runtime/src/channels/webhook.ts) — the source of truth.
