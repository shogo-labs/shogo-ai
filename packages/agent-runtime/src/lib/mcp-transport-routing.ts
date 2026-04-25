// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * MCP Transport Routing — pure helpers for Phase 5.
 *
 * Scope & status: this module is ADDITIVE. Nothing in the existing
 * mcp-client.ts imports it yet. It exists so follow-up PRs can
 * incrementally adopt transport-aware routing without a big-bang
 * change. See docs/mcp-transport-routing.md for rollout.
 *
 * The core idea:
 *   - stdio MCP should run on the user's worker when one is selected
 *     (to reach /Users/..., corp VPN, local filesystems).
 *   - HTTP/SSE MCP should always run in the cloud pod (its URL is
 *     reachable from anywhere; going through the tunnel just adds
 *     latency).
 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export type McpPin = 'auto' | 'cloud' | 'worker'

/** Compact description of the currently-active worker machine, if any. */
export interface ActiveInstanceRef {
  id: string
  /** Display name for UI; not used in routing decisions. */
  name?: string
}

export type McpHost =
  | { kind: 'cloud' }
  | { kind: 'worker'; instanceId: string }

export interface ChooseHostInput {
  transport: McpTransport
  /** null/undefined when the user hasn't selected a machine. */
  activeInstance?: ActiveInstanceRef | null
  /** Optional per-server pin override ('auto' == default by transport). */
  pin?: McpPin
}

/**
 * Deterministic routing rule. Pure function — safe to unit-test.
 *
 * Default-by-transport:
 *   - stdio    + activeInstance? -> worker ; else cloud
 *   - http/sse + any state       -> cloud
 *
 * A per-server pin ('cloud' | 'worker') always wins over the default,
 * EXCEPT that a 'worker' pin with no activeInstance silently falls back
 * to cloud (because there's no worker to route to). We prefer graceful
 * degradation over surfacing an error mid-session.
 */
export function chooseMcpHost(input: ChooseHostInput): McpHost {
  const { transport, activeInstance, pin = 'auto' } = input

  if (pin === 'cloud') return { kind: 'cloud' }

  if (pin === 'worker') {
    return activeInstance?.id
      ? { kind: 'worker', instanceId: activeInstance.id }
      : { kind: 'cloud' }
  }

  if (transport === 'stdio' && activeInstance?.id) {
    return { kind: 'worker', instanceId: activeInstance.id }
  }

  return { kind: 'cloud' }
}

/**
 * Narrow a mcp-client server-config object's shape to its transport type,
 * for callers that want to route BEFORE actually starting the server.
 * The shape here intentionally mirrors what mcp-client.ts accepts, so this
 * helper is drop-in whenever the call-site needs it.
 */
export function detectTransport(config: {
  /** Present for stdio servers. */
  command?: string
  /** Present for remote servers. */
  url?: string
}): McpTransport {
  if (typeof config.command === 'string' && config.command.length > 0) return 'stdio'
  if (typeof config.url === 'string' && /^wss?:\/\//i.test(config.url)) return 'sse'
  if (typeof config.url === 'string') return 'http'
  throw new Error('detectTransport: neither command nor url present on config')
}

/**
 * A Fetch-compatible factory that always sends requests from the cloud pod,
 * bypassing any active /p/* tunnel proxy. For HTTP MCP servers.
 *
 * Today this is just the ambient fetch — no special routing exists to
 * bypass. When the agent-runtime starts being invoked through /p/* (Phase 3),
 * callers should switch to this factory so HTTP MCP traffic doesn't double-hop
 * through the worker for no reason.
 *
 * Why this is a factory and not a constant: future rollout may add
 * configuration (custom agent, CA bundle, timeouts). Keeping it a factory
 * lets us evolve without touching call sites.
 */
export function getCloudFetcher(): typeof fetch {
  // NOTE: intentionally returns the default undici fetch. When /p/* proxying
  // is toggled on for agent-runtime outbound calls, this factory will wrap
  // the default with a dispatcher pinned to the cloud egress.
  return globalThis.fetch
}
