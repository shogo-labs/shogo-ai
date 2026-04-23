// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud Fetcher — a dispatcher-aware outbound client that always targets the
 * Shogo Cloud edge, regardless of where the current agent-runtime happens to
 * be running.
 *
 * Why this exists:
 *
 *   When a user pairs a machine via the Remote Control picker, their
 *   agent-runtime code ends up executing on the worker (via Phase 3's /p/*
 *   tunnel). That's exactly what we want for stdio MCP — spawned processes
 *   land on the user's box.
 *
 *   It's NOT what we want for HTTP MCP servers whose URL is a public host
 *   (e.g., api.linear.app/mcp). Running those from the worker adds a
 *   needless worker → internet hop. This module gives mcp-client.ts a drop-in
 *   dispatcher it can pass to StreamableHTTPClientTransport so the request is
 *   relayed through the cloud pod instead.
 *
 * Status: NOT YET WIRED INTO mcp-client.ts.
 *   This file is published ready-to-use. The wire-up lives in a follow-up PR
 *   (docs/mcp-transport-routing.md §"PR-2"). Importing from this file is a
 *   no-op until that PR lands.
 */

import { Agent, fetch as undiciFetch } from 'undici'

/**
 * Hosts considered "private" — not reachable from the cloud pod and therefore
 * must NOT be pinned to cloud. This is a pragmatic allowlist, not an RFC 1918
 * verifier; the set is intentionally conservative.
 */
const PRIVATE_HOST_SUFFIXES = [
  '.local',
  '.internal',
  '.corp',
  '.lan',
  '.intranet',
]

const PRIVATE_HOST_EXACT = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
])

/**
 * Decide if a URL should be executed from the cloud pod instead of the worker.
 *
 * Rules:
 *   - Explicit pin='cloud'  → always cloud.
 *   - Explicit pin='worker' → never cloud.
 *   - pin='auto' (default)  → cloud only if host is public.
 */
export type McpTransportPin = 'auto' | 'cloud' | 'worker'

export function shouldRouteThroughCloud(
  url: string,
  pin: McpTransportPin = 'auto',
): boolean {
  if (pin === 'cloud') return true
  if (pin === 'worker') return false
  // auto: only cloud-route public hosts
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (PRIVATE_HOST_EXACT.has(host)) return false
    if (PRIVATE_HOST_SUFFIXES.some((s) => host.endsWith(s))) return false
    // Bare numeric IPs in RFC 1918 space
    if (/^10\./.test(host)) return false
    if (/^192\.168\./.test(host)) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
    return true
  } catch {
    return false
  }
}

/**
 * A singleton undici Agent configured with defaults suited to long-lived MCP
 * HTTP/SSE sessions. Consumers don't need to touch this directly — use
 * getCloudDispatcher().
 */
let _agent: Agent | null = null

export function getCloudDispatcher(): Agent {
  if (_agent) return _agent
  _agent = new Agent({
    // MCP tools can run long; give them headroom.
    bodyTimeout: 0,
    headersTimeout: 60_000,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 10 * 60_000,
  })
  return _agent
}

/**
 * Pre-bound fetch that uses the cloud dispatcher. Useful for non-MCP code
 * paths that want the same semantics (e.g., outbound webhooks that must
 * originate from the cloud IP range).
 */
export function cloudFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // @ts-expect-error — undici's fetch accepts a dispatcher option that is
  // not part of the standard RequestInit type.
  return undiciFetch(input, { ...init, dispatcher: getCloudDispatcher() })
}

/**
 * Reset the cached dispatcher (test-only).
 *
 * `.close()` is a no-op under Bun's bundled undici shim (the method is not
 * implemented) but is a valid Promise-returning method in real undici. Guard
 * the call so tests work in both runtimes.
 */
export function _resetCloudDispatcherForTests(): void {
  if (_agent) {
    const closeFn = (_agent as { close?: () => Promise<void> | void }).close
    try {
      const maybePromise = typeof closeFn === 'function' ? closeFn.call(_agent) : undefined
      if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
        ;(maybePromise as Promise<void>).catch(() => { /* noop */ })
      }
    } catch { /* noop — shim without close */ }
    _agent = null
  }
}
