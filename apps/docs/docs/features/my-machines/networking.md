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

## A paired desktop's own workspaces

A desktop app that registers its own workspaces (`source: 'machine'`) serves
each of them from `GET /api/machines/:id/w/:localWorkspaceId/:rest`. That
relay carries **the workspace's own data** — its projects, chats, team chat and
workspace agent — because the desktop owns them and its workspace ids are not
the cloud's.

Nothing auto-prefixes a URL for you: a request is relayed only when all three of
these hold.

1. **The path is on the relay list.** While a machine workspace is open,
   `remote-http-interceptor.ts` adds a narrow set of workspace-scoped paths
   (`/api/workspaces/:id/agent-proxy`, `agent-profile`, `chat`, `history`,
   `conversations`, and the `/api/conversations` / `/api/conversation-messages`
   families). The workspace *list* itself, members, billing, analytics and
   exports stay on cloud — Settings must keep working while a machine workspace
   is open.
2. **The workspace id is rewritten.** The app builds URLs from the cloud
   workspace id it has in memory. On the way out, the interceptor replaces that
   id in the path, the `workspaceId` query param and the body with the machine's
   own id (`rewriteMachineWorkspacePath`).
3. **It goes through the client, not a hand-built `fetch`.** The interceptor
   only sees requests made through the domain HTTP client. A component that
   builds `${API_URL}/api/workspaces/...` by hand silently reaches cloud
   instead — pass the machine's agent base from `useWorkspaceAgentBase()`, or
   use the domain client.

Chat that goes through the relay must also be recognized as streaming: the
relay decides between `request`/`response` and `stream-chunk` with
`isStreamingRequest`, run against `normalizeTransparentProxyPath`. Both the
project wrapper (`/api/projects/:pid/agent-proxy`) and the workspace wrapper
(`/api/workspaces/:wsId/agent-proxy`) are unwrapped, so a workspace agent turn
arrives token by token rather than all at once when it ends.

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
