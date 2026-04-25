---
title: Networking & allowlist
sidebar_position: 2
---

# Networking & allowlist

The Shogo worker makes **only outbound connections**. No inbound ports are
opened on your machine, so you can run it from behind a NAT, VPN, or corporate
firewall without any additional configuration.

## Outbound hosts

| Host | Port | Purpose |
|---|---|---|
| `api.shogo.ai` | 443 | Heartbeat + WebSocket tunnel |
| `api-direct.shogo.ai` | 443 | Direct-path fallback when API is behind a load balancer drain |
| `artifacts.shogo.ai` | 443 | Signed-URL artifact uploads (file downloads/uploads from chat) |

If your firewall enforces an allowlist, add all three.

## Proxy support

The worker reads standard proxy env vars:

```bash
HTTPS_PROXY=http://proxy.corp.example.com:3128 \
NO_PROXY=localhost,127.0.0.1 \
shogo worker start
```

`shogo worker start --debug` will print the effective proxy configuration in
the preflight output.

## Tunnel protocol (brief)

Once paired, the worker opens a single long-lived WSS connection:

```
GET /api/instances/ws?key=...&hostname=...&os=darwin&arch=arm64
```

The server **upserts the Instance row on connect** keyed on
`(workspaceId, hostname)` — no separate registration step. Messages flow as
JSON frames:

- `request` → `response` | `stream-chunk`* → `stream-end`
- `heartbeat` (worker → server, every 25s)
- `pong` (reply to server pings)
- `cancel` (in-flight request abort)

When chat uses a remote machine, the agent URL is rewritten to
`https://api.shogo.ai/api/instances/:id/p/agent-proxy/...` and the cloud
transparently forwards requests through the tunnel. Streaming endpoints
(`/agent/chat`, `/agent/canvas/stream`, `/agent/logs/stream`) are auto-detected
and relayed as `stream-chunk` frames.

## Data that leaves the worker

The worker runs your existing `apps/api` Bun server locally; the cloud never
sees your filesystem directly. When chat asks for a file, the cloud sends a
tunneled HTTP request, your worker's local server reads the file, and the
contents are returned inside the tunnel response. File writes follow the same
path.

:::note
The worker is sandboxed to `--worker-dir` for local file system operations via
the existing Hono route handlers. `exec_command` is **not** jailed (parity
with Cursor's desktop agent) — any command your user can run, the worker can
run.
:::
