// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which runtime paths answer as an event stream, in one place (SHO-486).
 *
 * Two proxies decide this and they used to disagree: `routes/instances` (a
 * direct instance proxy) knew that a chat `/stream` GET is a long-lived stream,
 * while `lib/host-tunnel` did not. So a client rejoining a desktop-hosted turn
 * through the cloud took the buffered path, waited out the 30 s proxy timeout and
 * got `502 host_tunnel_error "Proxy request timed out"` with no bytes — the
 * desktop's own turn was fine, the way back was not.
 *
 * `path` is the runtime-relative path (`/agent/chat/<id>/stream`), with or
 * without a query string.
 */

/** A chat POST streams tokens as SSE. */
const STREAMING_POST_PATHS = ['/agent/chat', '/agent/quick-actions', '/agent/logs/stream']

/** A GET that streams: canvas frames, logs, a chat resume, a workspace event feed. */
const STREAMING_GET_PATHS = ['/agent/canvas/stream', '/agent/logs/stream']

const matches = (path: string, pattern: string) => path === pattern || path.startsWith(`${pattern}/`)

/** `/agent/chat/<sessionId>/stream` — the AI SDK resume URL. */
export const CHAT_RESUME_STREAM_RE = /^\/agent\/chat\/[^/]+\/stream$/

/** A workspace's team-chat event feed (SSE), long-lived by design. */
export const WORKSPACE_EVENT_STREAM_RE = /^\/api\/workspaces\/[^/]+\/conversations\/events$/

export function isAgentStreamPath(method: string, pathWithQuery: string): boolean {
  const path = typeof pathWithQuery === 'string' ? pathWithQuery.split('?')[0] || pathWithQuery : ''
  if (method === 'POST') return STREAMING_POST_PATHS.some((pattern) => matches(path, pattern))
  if (method !== 'GET') return false
  return STREAMING_GET_PATHS.some((pattern) => matches(path, pattern)) ||
    CHAT_RESUME_STREAM_RE.test(path) ||
    WORKSPACE_EVENT_STREAM_RE.test(path)
}

/**
 * Strip the agent-proxy wrapper from a tunneled path, returning the
 * runtime-relative one (`/api/workspaces/<id>/agent-proxy/agent/chat` →
 * `/agent/chat`). Query string dropped. Shared by `routes/instances` (which
 * decides what to relay as a stream) and `lib/tunnel-redis` (which decides
 * whether a relay is bounded by wall clock) so the two cannot disagree again.
 */
export function stripAgentProxyWrapper(pathWithQuery: string): string {
  const pathWithoutQuery = typeof pathWithQuery === 'string' ? pathWithQuery.split('?')[0] || pathWithQuery : ''
  const wrapped = pathWithoutQuery.match(
    /^\/api\/(?:projects|workspaces)\/[^/]+\/agent-proxy(\/.*)?$/,
  )
  if (wrapped) return wrapped[1] || '/agent'
  return pathWithoutQuery
}

/**
 * Whether a *tunneled* path streams an agent turn, wrapper and all (SHO-546).
 *
 * A tunnel request carries the path the desktop's own proxy serves —
 * `/api/workspaces/<id>/agent-proxy/agent/chat/<id>/stream` — so
 * `isAgentStreamPath` alone answers false for it and the caller falls back to a
 * wall-clock cap that kills a live turn mid-stream.
 */
export function isAgentStreamTunnelPath(method: string, pathWithQuery: string): boolean {
  return isAgentStreamPath(method, stripAgentProxyWrapper(pathWithQuery))
}
