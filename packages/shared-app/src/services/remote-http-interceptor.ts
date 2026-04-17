// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote HTTP Interceptor
 *
 * Wraps the SDK HttpClient to transparently route stateful API requests
 * through the instance tunnel when a remote desktop is connected.
 *
 * When `remoteProxyBaseUrl` is set (e.g. `/api/instances/<id>/p`),
 * requests to paths like `/api/projects`, `/api/chat-sessions`, etc.
 * are rewritten to go through the transparent proxy, hitting the desktop
 * instance's local API instead of the cloud backend.
 *
 * This makes the desktop the source of truth for all stateful data
 * (projects, agents, chat history) while connected.
 *
 * Routing uses an explicit route table — NOT simple prefix matching —
 * to correctly handle hybrid paths where a parent is remote-routed but
 * a sub-path is cloud-only (e.g. /api/projects is remote, but
 * /api/projects/:id/publish is cloud).
 */

import type { HttpClient } from '@shogo-ai/sdk'

// ─── Route Table ────────────────────────────────────────────────────────────

/**
 * Explicit route table for remote routing.
 *
 * Each entry is a regex + target. We check CLOUD entries first (they
 * take priority), then REMOTE entries.  This means sub-paths can be
 * pinned to cloud even though their parent prefix is remote.
 *
 * The order matters: more-specific patterns MUST come before
 * less-specific ones within the same target group.
 */
type RouteTarget = 'remote' | 'cloud'

interface RouteEntry {
  pattern: RegExp
  target: RouteTarget
}

const ROUTE_TABLE: RouteEntry[] = [
  // ── Cloud-pinned sub-paths (checked FIRST) ─────────────────────────
  // These are hybrid: the parent (/api/projects) is remote, but these
  // specific operations only make sense in the cloud.
  { pattern: /^\/api\/projects\/[^/]+\/publish/,           target: 'cloud' },
  { pattern: /^\/api\/projects\/[^/]+\/unpublish/,         target: 'cloud' },
  { pattern: /^\/api\/projects\/[^/]+\/thumbnail/,         target: 'cloud' },
  { pattern: /^\/api\/projects\/[^/]+\/s3\//,              target: 'cloud' },
  { pattern: /^\/api\/projects\/[^/]+\/heartbeat\/sync/,   target: 'cloud' },
  // Billing / marketplace / admin — cloud-only by their prefix
  { pattern: /^\/api\/billing/,                              target: 'cloud' },
  { pattern: /^\/api\/admin/,                                target: 'cloud' },
  { pattern: /^\/api\/marketplace/,                          target: 'cloud' },
  { pattern: /^\/api\/instances/,                            target: 'cloud' },
  { pattern: /^\/api\/auth/,                                 target: 'cloud' },
  { pattern: /^\/api\/invitations/,                          target: 'cloud' },
  { pattern: /^\/api\/members/,                              target: 'cloud' },
  { pattern: /^\/api\/workspaces/,                           target: 'cloud' },
  { pattern: /^\/api\/subscriptions/,                        target: 'cloud' },
  { pattern: /^\/api\/sync/,                                 target: 'cloud' },

  // ── Remote-routed paths ────────────────────────────────────────────
  // Desktop is source of truth for these. Order: most specific first.
  { pattern: /^\/api\/projects(\/|\?|$)/,                   target: 'remote' },
  { pattern: /^\/api\/chat-sessions(\/|\?|$)/,              target: 'remote' },
  { pattern: /^\/api\/chat-messages(\/|\?|$)/,              target: 'remote' },
  { pattern: /^\/api\/tool-call-logs(\/|\?|$)/,             target: 'remote' },
  { pattern: /^\/api\/folders(\/|\?|$)/,                    target: 'remote' },
  { pattern: /^\/api\/starred-projects(\/|\?|$)/,           target: 'remote' },
]

/**
 * Legacy prefix list for backward-compat exports.
 * @deprecated Use ROUTE_TABLE instead.
 */
const REMOTE_ROUTED_PREFIXES = [
  '/api/projects',
  '/api/chat-sessions',
  '/api/chat-messages',
  '/api/tool-call-logs',
  '/api/folders',
  '/api/starred-projects',
]

/**
 * Legacy exclusion patterns.
 * @deprecated Use ROUTE_TABLE cloud entries instead.
 */
const REMOTE_EXCLUDED_PATTERNS = [
  /^\/api\/projects\/[^/]+\/publish/,
  /^\/api\/projects\/[^/]+\/thumbnail/,
]

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RemoteInterceptorConfig {
  /**
   * Base URL for the transparent proxy, e.g.:
   * `${apiUrl}/api/instances/${instanceId}/p`
   *
   * When null/undefined, all requests go to cloud backend (normal mode).
   */
  remoteProxyBaseUrl: string | null

  /**
   * Protocol version header sent with remote requests.
   * Allows the desktop to detect version mismatches.
   */
  protocolVersion?: number

  /** Sync protocol version (for event schema compat) */
  syncVersion?: number

  /** Client app version (for rolling-update compat) */
  clientVersion?: string

  /**
   * Called when a remote request fails due to tunnel disconnect.
   * The UI can show a fallback banner or auto-switch to local mode.
   */
  onRemoteError?: (error: Error, path: string) => void
}

// ─── Path Routing Logic ─────────────────────────────────────────────────────

/**
 * Determine if a given API path should be routed to the remote desktop.
 *
 * Walks the explicit ROUTE_TABLE. Cloud entries are checked first (they
 * are listed first in the table) so hybrid sub-paths like
 * `/api/projects/:id/publish` hit cloud even though `/api/projects` is
 * remote.  First match wins.
 */
export function shouldRouteToRemote(path: string): boolean {
  // Strip query string for matching — qs is preserved during rewrite.
  const pathOnly = path.split('?')[0] || path

  for (const entry of ROUTE_TABLE) {
    if (entry.pattern.test(pathOnly)) {
      return entry.target === 'remote'
    }
  }

  // No match → cloud (safe default)
  return false
}

/**
 * Rewrite an API path to go through the transparent proxy.
 *
 * Input:  `/api/projects`
 * Output: `https://studio.shogo.ai/api/instances/<id>/p/api/projects`
 *
 * The transparent proxy on the cloud server strips the prefix and forwards
 * the request to the desktop's local API server.
 */
export function rewritePathForRemote(
  originalPath: string,
  remoteProxyBaseUrl: string,
): string {
  // remoteProxyBaseUrl is like: https://studio.shogo.ai/api/instances/<id>/p
  // We need: https://studio.shogo.ai/api/instances/<id>/p/api/projects
  // The path already starts with / so we just concatenate
  return `${remoteProxyBaseUrl}${originalPath}`
}

// ─── HttpClient Proxy ───────────────────────────────────────────────────────

/**
 * Create a proxy around an HttpClient that intercepts requests and routes
 * them through the remote instance tunnel when appropriate.
 *
 * This uses a JavaScript Proxy so we don't need to modify the HttpClient
 * class itself — it's a transparent wrapper.
 *
 * @param http - The original HttpClient instance
 * @param getConfig - Function that returns the current interceptor config
 *                    (must be a function so it picks up reactive changes)
 */
export function createRemoteAwareHttpClient(
  http: HttpClient,
  getConfig: () => RemoteInterceptorConfig,
): HttpClient {
  // We intercept the methods that make HTTP calls: get, post, patch, delete, request
  // The key insight: these methods accept a `path` as first argument.
  // When remote is connected and the path should be routed, we rewrite it.

  const handler: ProxyHandler<HttpClient> = {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver)

      // Only intercept HTTP method calls
      if (
        typeof original !== 'function' ||
        !['get', 'post', 'patch', 'delete', 'request'].includes(prop as string)
      ) {
        return original
      }

      return function (this: HttpClient, ...args: any[]) {
        const config = getConfig()

        // If no remote connection, pass through unchanged
        if (!config.remoteProxyBaseUrl) {
          return (original as Function).apply(target, args)
        }

        // Extract path from arguments
        const path: string = args[0]

        // Check if this path should be routed to remote
        const shouldRoute = shouldRouteToRemote(path)

        if (!shouldRoute) {
          return (original as Function).apply(target, args)
        }

        // Rewrite the path to go through the tunnel proxy
        const rewrittenPath = rewritePathForRemote(path, config.remoteProxyBaseUrl)
        const newArgs = [...args]
        newArgs[0] = rewrittenPath

        // Build the common header bag once
        const remoteHeaders: Record<string, string> = {
          'x-remote-control': 'true',
          ...(config.protocolVersion
            ? { 'x-remote-protocol-version': String(config.protocolVersion) }
            : {}),
          ...(config.syncVersion
            ? { 'x-sync-version': String(config.syncVersion) }
            : {}),
          ...(config.clientVersion
            ? { 'x-client-version': config.clientVersion }
            : {}),
        }

        // For methods that accept headers, inject remote control headers
        if (prop === 'request' && typeof newArgs[1] === 'object' && newArgs[1] !== null) {
          newArgs[1] = {
            ...newArgs[1],
            headers: {
              ...(newArgs[1].headers || {}),
              ...remoteHeaders,
            },
          }
        } else if (prop === 'post' || prop === 'patch') {
          // post(path, body?, headers?) — headers is the 3rd arg
          const existingHeaders = newArgs[2] || {}
          newArgs[2] = {
            ...existingHeaders,
            ...remoteHeaders,
          }
        }

        // Execute the rewritten request with error handling
        const result = (original as Function).apply(target, newArgs)

        // If it's a promise (all HTTP methods return promises), add error handling
        if (result && typeof result.then === 'function') {
          return result.catch((error: Error) => {
            // Notify caller about remote errors for fallback handling
            config.onRemoteError?.(error, path)
            throw error
          })
        }

        return result
      }
    },
  }

  return new Proxy(http, handler)
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { REMOTE_ROUTED_PREFIXES, REMOTE_EXCLUDED_PATTERNS, ROUTE_TABLE, type RouteTarget, type RouteEntry }
