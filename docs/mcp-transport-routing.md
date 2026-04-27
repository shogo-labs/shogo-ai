<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# MCP Transport Routing

When a user pairs their own machine via the Remote Control (My Machines) picker, we need a principled answer to: **"where does each MCP server actually run?"**

This document is the spec. Audited against `feat/shogo-cloud-code` @ 2026-04-23.

## The model

Each MCP server is one of two shapes, distinguished by transport:

| Transport | MCP client class | Execution model |
|-----------|------------------|-----------------|
| **stdio** | `StdioClientTransport` | We spawn a child process and pipe stdin/stdout. |
| **HTTP / SSE** | `StreamableHTTPClientTransport` | We open an HTTP connection to a URL the user provided. |

And each session is one of two modes:

| Mode | Signal | Where agent-runtime code executes |
|------|--------|-----------------------------------|
| **Cloud** | `activeInstance` is null | Shogo cloud pod (default — 99%+ of sessions today). |
| **Machine** | `activeInstance.instanceId` is set | User's worker machine (Phase 1 CLI or Desktop). |

## What happens today

`packages/agent-runtime/src/mcp-client.ts` is the single entry point for MCP server management. It has two methods:

- `startServer(name, config)` → spawns the stdio child at `mcp-client.ts:297`.
- `startRemoteServer(name, config)` → opens the HTTP connection at `mcp-client.ts:443`.

Both methods execute **wherever the agent-runtime itself is running**. We do not have explicit "spawn this on cloud" / "spawn this on worker" knobs inside mcp-client.

When a user picks a machine from the chat header:

1. The mobile app flips the project's agent-proxy URL to `${remoteAgentBaseUrl}/api/projects/:id/agent-proxy/*` (see `apps/mobile/app/(app)/projects/[id]/_layout.tsx:327`).
2. `remoteAgentBaseUrl` is `${apiUrl}/api/instances/${instanceId}/p`.
3. The cloud's `apps/api` receives the request, hits its `ALL /instances/:id/p/*` transparent proxy (`apps/api/src/routes/instances.ts:1041`), which forwards the request over the WS tunnel to the worker's local `apps/api`.
4. The worker's local `apps/api` handles the `/api/projects/:id/agent-proxy/*` path and invokes its local agent-runtime, which in turn calls into its local `mcp-client.ts`.
5. `StdioClientTransport.spawn` runs on the worker machine. ✓

**Result: stdio MCP servers correctly run on the worker with no code change.**

**But:** `StreamableHTTPClientTransport` also runs from the worker in this mode. That is:

- ✅ Correct for private-network URLs (e.g., `http://localhost:3001`, `https://internal.corp/mcp`).
- ⚠️ Needlessly indirect for public URLs (e.g., `https://api.linear.app/mcp`), because the traffic goes worker → internet → service, instead of cloud-pod → internet → service. Extra latency, no security benefit.

## The routing matrix we want

| Transport | No machine active | Machine selected + pin=auto | Pin=cloud | Pin=worker |
|-----------|-------------------|------------------------------|-----------|------------|
| stdio     | ☁ Cloud pod       | 🖥 Worker                   | ☁ Cloud (spawns in pod via direct agent URL) | 🖥 Worker |
| HTTP/SSE  | ☁ Cloud pod       | **See below**                | ☁ Cloud   | 🖥 Worker  |

`pin=auto` for HTTP/SSE resolves to:

- **Cloud** if the URL host is public (not RFC 1918 / loopback / `.local` / `.internal`).
- **Worker** if the URL host is private — reaching a private URL from cloud would 404 / timeout anyway.

Per-server pin is user-overridable via the MCP settings page.

## How this ships

Phase 5 is additive. The four new artifacts (in this PR / Phase 5):

1. `docs/mcp-transport-routing.md` — this file.
2. `packages/agent-runtime/src/lib/cloud-fetcher.ts` — a ready-to-use HTTP client that always reaches the cloud apps/api edge, for when we're ready to pin HTTP MCP to cloud from the worker. Not yet wired into `mcp-client.ts`.
3. `packages/agent-runtime/src/__tests__/mcp-transport-routing.test.ts` — integration test skeleton + static-analysis assertions that document current behavior and will catch regressions.
4. `apps/mobile/components/chat/TransportBadge.tsx` — presentational component for the "runs on ☁ Cloud / 🖥 my-devbox" pill. Not yet wired into existing tool-call displays.

## How to wire it up (follow-up PRs)

### PR-1 (~1 h, low risk) — Badge wiring

Import `<TransportBadge />` in:

- `apps/mobile/components/chat/ToolCallDisplay.tsx`
- `apps/mobile/components/chat/tools/ToolPill.tsx`
- `apps/mobile/components/chat/turns/ToolCallGroup.tsx`

Only render when `transportLocation !== 'default'`. Zero visual change for 99%+ of sessions today.

### PR-2 (~1-2 h, medium risk) — HTTP MCP pin-to-cloud (auto)

In `packages/agent-runtime/src/mcp-client.ts` `startRemoteServer`:

```ts
const transport = new StreamableHTTPClientTransport(
  new URL(config.url),
  {
    requestInit: {
      ...(config.headers ? { headers: config.headers } : {}),
      // opt-in: if we're running on a worker AND the URL is public AND pin !== 'worker',
      // route outbound fetches via cloud-fetcher so the cloud pod makes the call instead.
      ...(shouldPinToCloud(config) ? { dispatcher: getCloudDispatcher() } : {}),
    },
  },
)
```

Gate behind `SHOGO_MCP_PIN_HTTP_TO_CLOUD=true` for the first rollout so we can flip it per workspace.

### PR-3 (~30 m, tiny) — MCP settings UI

Add a per-server pin dropdown (auto / cloud / worker) in `apps/mobile/app/(app)/settings/mcp.tsx`. Persists to the existing config.json-based MCP store.

## Why this split

Each PR is independently revertable and has a blast radius of one file or one subsystem. The 4 artifacts in Phase 5 are new-file-only — nothing is modified in-place, so Phase 5 itself cannot cause a regression.

## Validation checklist

- [x] stdio MCP spawns on the worker when activeInstance is set (verified by static analysis of `mcp-client.ts:297` + Phase 3 wiring).
- [x] HTTP MCP connects from wherever agent-runtime runs (verified: `mcp-client.ts:443` uses `new URL(config.url)` without proxy/dispatcher).
- [x] No existing flow regresses when activeInstance is null (no existing code is modified in Phase 5).
- [ ] **PR-2** will add the actual pin-to-cloud behavior for HTTP MCP when a worker is active.
- [ ] **PR-1** will make the routing visible to users via `<TransportBadge />`.
- [ ] **PR-3** will give users override control via pin dropdown.
