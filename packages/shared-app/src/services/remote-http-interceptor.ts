// SPDX-License-Identifier: MIT
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
  // `/republish` ("Publish latest changes") must hit cloud too — it does NOT
  // match the `/publish` pattern above (republish !== publish), so without this
  // it would fall through to the `/api/projects` remote rule and be sent to the
  // desktop's no-op stub instead of redeploying via the cloud pipeline.
  { pattern: /^\/api\/projects\/[^/]+\/republish/,         target: 'cloud' },
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
 * Paths that only belong to the desktop while one of its *own* workspaces is
 * open (`source: 'machine'`).
 *
 * Routing does not need a list of what to send to the machine: everything
 * workspace-scoped is the machine's while you are looking at the machine's
 * workspace. What it needs is the opposite — the few families that stay the
 * *cloud* workspace's, because a machine has no billing account, no cloud
 * membership and no Slack/Discord install to read. Those are pinned here and
 * checked before the machine rule. Its own analytics *are* the machine's — a
 * workspace's usage numbers describe the workspace you are looking at.
 *
 * The workspace *collection* (`/api/workspaces`, no id) is not workspace-scoped
 * and is untouched by the rule below: a machine workspace must never replace
 * the switcher's own workspace list.
 */
const MACHINE_WORKSPACE_CLOUD_ONLY: RouteEntry[] = [
  // A Slack/Discord/Teams install is configured cloud-side for a cloud
  // workspace; a machine workspace has no install to show.
  { pattern: /^\/api\/workspaces\/[^/]+\/chat-installations(\/|$)/, target: 'cloud' },
  { pattern: /^\/api\/workspaces\/[^/]+\/redeem-license(\/|$)/,    target: 'cloud' },
  // Membership and lifecycle of the cloud workspace: leaving it, its deletion
  // preview and its member activity are all cloud rows.
  { pattern: /^\/api\/workspaces\/[^/]+\/(deletion-preview|leave|permissions|member-activity)(\/|$)/, target: 'cloud' },
  // Settings → Compute (instance, metrics, storage) and Billing's pooled child
  // workspaces are served only by the cloud API; the desktop does not mount
  // them, so routing them to the machine 404s. Export is the cloud workspace's
  // too: the download itself is a raw fetch to cloud, so its estimate must be.
  { pattern: /^\/api\/workspaces\/[^/]+\/(instance|metrics|storage|children|export)(\/|$)/, target: 'cloud' },
  // Cloud-account integrations (OAuth credentials live cloud-side).
  { pattern: /^\/api\/workspaces\/[^/]+\/(social|integrations)(\/|$)/, target: 'cloud' },

  // ── Cloud-account families, by declaration ────────────────────────
  // A machine has no billing account, no cloud membership and no cloud
  // marketplace install. These are the cloud workspace's while its rows are on
  // screen — named here with their reason so the choice is a decision, not a
  // fall-through someone might "fix" later.
  { pattern: /^\/api\/billing(\/|$)/,       target: 'cloud' }, // no billing account on a machine
  { pattern: /^\/api\/subscriptions(\/|$)/, target: 'cloud' }, // same account, same reason
  { pattern: /^\/api\/members(\/|$)/,       target: 'cloud' }, // cloud membership, not the machine's
  { pattern: /^\/api\/invitations(\/|$)/,   target: 'cloud' }, // you join cloud workspaces, not machines
  { pattern: /^\/api\/marketplace(\/|$)/,   target: 'cloud' }, // listings live in the cloud
  { pattern: /^\/api\/admin(\/|$)/,         target: 'cloud' }, // platform administration
  { pattern: /^\/api\/auth(\/|$)/,          target: 'cloud' }, // the session that authorises this app
  { pattern: /^\/api\/instances(\/|$)/,     target: 'cloud' }, // the cloud's instance registry
  { pattern: /^\/api\/machines(\/|$)/,      target: 'cloud' }, // the machine list itself
  // Compose port preview is served by the cloud API only (`server.ts`); the
  // desktop app does not mount it. The caller is still a bare client today, so
  // nothing breaks — but the day it converts to the workspace client,
  // `/api/projects` would take it to the machine and 404.
  { pattern: /^\/api\/projects\/[^/]+\/ports(\/|$)/, target: 'cloud' },
  { pattern: /^\/api\/sync(\/|$)/,          target: 'cloud' }, // cloud sync transport
]

/**
 * A workspace-scoped URL: `/api/workspaces/<id>/…`. The trailing segment is what
 * separates it from the collection endpoint.
 */
const MACHINE_WORKSPACE_SCOPE = /^\/api\/workspaces\/[^/?#]+\//

/**
 * Workspace features the machine serves from a *top-level* path: they name a
 * board, a card or the agent in the path or query rather than a workspace, so
 * the `/api/workspaces/:id/…` scope never sees them. Declared here once, so a
 * new one is added to the list instead of silently reading the cloud.
 */
const MACHINE_WORKSPACE_OWNED: RouteEntry[] = [
  // Boards and the cards on them: the board list, a board's view, a card's
  // detail, its move, comments, history, links, follow and archive.
  { pattern: /^\/api\/boards(\/|\?|$)/,          target: 'remote' },
  { pattern: /^\/api\/work-items(\/|\?|$)/,      target: 'remote' },
  // A folder of projects and a session's project membership are rows the
  // workspace's own database holds (`/api/project-folders`,
  // `/api/chat-session-projects` are mounted locally), so a board/card screen
  // and a session pane read them from the machine that owns them.
  { pattern: /^\/api\/project-folders(\/|\?|$)/,        target: 'remote' },
  { pattern: /^\/api\/chat-session-projects(\/|\?|$)/,  target: 'remote' },
  // The agent task board and the agent pickers the composer asks for.
  { pattern: /^\/api\/agent-tasks(\/|\?|$)/,     target: 'remote' },
  { pattern: /^\/api\/chat-mentionables(\/|\?|$)/,    target: 'remote' },
  { pattern: /^\/api\/chat-mention-status(\/|\?|$)/,  target: 'remote' },
  // Chat plumbing that names the file or message rather than the workspace.
  { pattern: /^\/api\/conversation-files(\/|\?|$)/,    target: 'remote' },
  { pattern: /^\/api\/chat-attachments(\/|\?|$)/,      target: 'remote' },
  { pattern: /^\/api\/chat-queued-messages(\/|\?|$)/,  target: 'remote' },
]

/**
 * Team-chat families that name their workspace in the query string or in a
 * nested id rather than in the path, so they never reach the rule above.
 */
const MACHINE_WORKSPACE_FAMILIES: RouteEntry[] = [
  { pattern: /^\/api\/conversations(\/|$)/,                 target: 'remote' },
  { pattern: /^\/api\/conversation-messages(\/|$)/,         target: 'remote' },
  { pattern: /^\/api\/scheduled-messages(\/|$)/,            target: 'remote' },
  { pattern: /^\/api\/reminders(\/|$)/,                     target: 'remote' },
  { pattern: /^\/api\/custom-emoji(\/|$)/,                  target: 'remote' },
  { pattern: /^\/api\/user-groups(\/|$)/,                   target: 'remote' },
]

/**
 * Reads that must still go through the tunnel, because the *answer* is not a
 * database row that the cloud copy can serve — it is the machine's own runtime
 * talking (an agent turn streaming back, a preview frame, a file on its disk).
 *
 * Every other read of a machine workspace is answered from the cloud copy of
 * its rows (SHO-185): the copy keeps the desktop's row ids, so a panel loads the
 * same records whether the machine is awake or asleep, and wakes only when it
 * does something.
 */
const MACHINE_WORKSPACE_LIVE_READS: RouteEntry[] = [
  // Agent turns, runtime start/stop and the proxy the chat pane talks through.
  { pattern: /^\/api\/workspaces\/[^/]+\/agent-proxy(\/|$)/, target: 'remote' },
  // The machine's own runtime surface: preview frames, ports, its IDE, its
  // files on disk.
  { pattern: /^\/api\/workspaces\/[^/]+\/(preview|runtime|ide|local-files|terminal|files)(\/|$)/, target: 'remote' },
  // Attachment and conversation-file *contents* are bytes on the machine; the
  // row that names them is mirrored, the file is not.
  { pattern: /^\/api\/(conversation-files|chat-attachments)\/[^/]+(\/|$)/, target: 'remote' },
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

  /**
   * Set when `remoteProxyBaseUrl` targets one of a paired desktop's own
   * workspaces (`/api/machines/<id>/w/<localWorkspaceId>`). Cloud and machine
   * workspace ids come from different databases, so a `workspaceId` the UI
   * sends along (the cloud one that happens to be selected) is rewritten to
   * the machine's own id — otherwise the desktop filters its projects by an
   * id it has never heard of and answers `200 []`, which reads as "my
   * projects vanished".
   */
  machineWorkspaceId?: string | null

  /**
   * A machine-workspace request failed with one of the machine's own codes
   * (`waking`, `runtime_starting`, `machine_offline_readonly`). The screen that
   * owns the machine state decides what to show; the interceptor only reports,
   * so every caller cannot drift into a different wording.
   */
  onMachineState?: (error: unknown, path: string) => void
}

/**
 * Point a machine-workspace request at the machine's own workspace id.
 *
 * Only the query string is touched: routing decisions and the path itself are
 * workspace-agnostic, and the relay already carries the local workspace id.
 */
export function rewriteMachineWorkspaceParam(path: string, localWorkspaceId: string): string {
  const queryStart = path.indexOf('?')
  if (queryStart === -1) return path
  const pathname = path.slice(0, queryStart)
  const params = new URLSearchParams(path.slice(queryStart + 1))
  if (!params.has('workspaceId') || params.get('workspaceId') === localWorkspaceId) return path
  params.set('workspaceId', localWorkspaceId)
  return `${pathname}?${params.toString()}`
}

/**
 * Point a machine-workspace request at the machine's own workspace id when the
 * id sits in the path (`/api/workspaces/:id/agent-proxy/…`).
 *
 * A workspace-scoped URL the cloud app builds carries the cloud workspace id,
 * which the desktop has never heard of: it would resolve to no workspace and
 * answer 404 (or, worse, to whichever row happened to match). The query and
 * body rewrites below cannot reach that segment.
 */
export function rewriteMachineWorkspacePath(path: string, localWorkspaceId: string): string {
  return path.replace(
    /^\/api\/workspaces\/[^/?#]+/,
    `/api/workspaces/${encodeURIComponent(localWorkspaceId)}`,
  )
}

/**
 * Point a machine-workspace request body at the machine's own workspace id.
 *
 * Creates carry `workspaceId` in the body while the UI still holds the cloud
 * id it was showing; leaving it means the desktop cannot resolve the id and
 * files the project or folder into whichever workspace happens to be first.
 * Only plain JSON objects are touched — files, strings and arrays pass through.
 */
export function rewriteMachineWorkspaceBody<T>(body: T, localWorkspaceId: string): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const record = body as Record<string, unknown>
  if (typeof record.workspaceId !== 'string' || record.workspaceId === localWorkspaceId) return body
  return { ...record, workspaceId: localWorkspaceId } as T
}

/**
 * What a machine-workspace request may come back with, and what the UI should do
 * about it (SHO-185). The codes are the ones the cloud's machine routes emit; a
 * screen that maps them once cannot drift into showing "Machine is offline" for a
 * machine that is merely waking.
 */
export const MACHINE_ERROR_CODES = {
  /** Recently heartbeated, tunnel still coming up: retry in a moment. */
  waking: 'waking',
  /** The desktop is starting a cold runtime: retry in a moment. */
  runtimeStarting: 'runtime_starting',
  /** Connected, but the request did not come back in time: show it. */
  machineTimeout: 'machine_timeout',
  /**
   * The machine is offline: the workspace is read-only until it is back. Nothing
   * is queued, so a send cannot be retried into a surprise later.
   */
  offlineReadonly: 'machine_offline_readonly',
  /**
   * The cloud has no copy of this machine workspace (yet, or at all): the read
   * has to go through the relay. Never shown to a person — the interceptor
   * retries it (SHO-241).
   */
  copyPending: 'machine_copy_pending',
} as const

export type MachineErrorCode = (typeof MACHINE_ERROR_CODES)[keyof typeof MACHINE_ERROR_CODES]

/** True for the two codes that mean "the machine is coming up; try again". */
export function isMachineWakeError(status: number, code?: string | null): boolean {
  if (status !== 503) return false
  return code === MACHINE_ERROR_CODES.waking || code === MACHINE_ERROR_CODES.runtimeStarting
}

/** True when the workspace should be read-only until the machine comes back. */
export function isMachineOfflineReadOnly(status: number, code?: string | null): boolean {
  return status === 409 && code === MACHINE_ERROR_CODES.offlineReadonly
}

/** A read: served from the cloud copy, never through the tunnel. */
function isReadCall(prop: string, args: any[]): boolean {
  if (prop === 'get') return true
  if (prop !== 'request') return false
  const init = args[1]
  const method = typeof init?.method === 'string' ? init.method.toUpperCase() : 'GET'
  return method === 'GET' || method === 'HEAD'
}

/**
 * True for the cloud's "this workspace lives on your machine and I have no copy
 * of it" answer (SHO-241).
 *
 * The cloud answers `409 machine_copy_pending` instead of the misleading
 * `403 "No access to this workspace"`, and the read has to be retried through the
 * machine relay — which is what makes a machine workspace usable before its first
 * sync finishes (or while sync is off) rather than looking unshared.
 */
export function isMachineCopyPendingError(error: unknown): boolean {
  const err = error as { status?: number; details?: any } | null
  if (!err || err.status !== 409) return false
  const code = err.details?.error?.code ?? err.details?.code
  return code === MACHINE_ERROR_CODES.copyPending
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
export function shouldRouteToRemote(
  path: string,
  opts?: { machineWorkspaceId?: string | null; isRead?: boolean },
): boolean {
  // Strip query string for matching — qs is preserved during rewrite.
  const pathOnly = path.split('?')[0] || path

  // A paired desktop's own workspace owns everything scoped to it: its agent,
  // its sessions, its team chat and its records. Deciding it here, once, is
  // what keeps the screens from each choosing a host — a new workspace-scoped
  // call is routed the day it is written instead of the day someone remembers
  // to add it to a list.
  if (opts?.machineWorkspaceId) {
    // …except the families that are still the *cloud* workspace's (billing,
    // membership, installs) — a machine has none of them.
    for (const entry of MACHINE_WORKSPACE_CLOUD_ONLY) {
      if (entry.pattern.test(pathOnly)) return false
    }
    // A read is answered by the cloud copy of the machine's rows, so a panel
    // opens on the same records with the machine asleep. Only the reads whose
    // answer is the machine's runtime (an agent turn, a preview frame, a file on
    // its disk) still go through the tunnel.
    if (opts.isRead && !MACHINE_WORKSPACE_LIVE_READS.some((entry) => entry.pattern.test(pathOnly))) {
      return false
    }
    if (MACHINE_WORKSPACE_SCOPE.test(pathOnly)) return true
    for (const entry of MACHINE_WORKSPACE_OWNED) {
      if (entry.pattern.test(pathOnly)) return true
    }
    for (const entry of MACHINE_WORKSPACE_FAMILIES) {
      if (entry.pattern.test(pathOnly)) return true
    }
  }

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
        const originalPath: string = args[0]

        // Check if this path should be routed to remote. A machine workspace
        // widens the remote set (its own agent and team chat live on the
        // desktop), but a *read* of its records is answered by the cloud copy —
        // so the same panel opens with the machine asleep, and the machine is
        // woken by the edit, not by the page load.
        const isRead = isReadCall(String(prop), args)
        const shouldRoute = shouldRouteToRemote(originalPath, {
          machineWorkspaceId: config.machineWorkspaceId,
          isRead,
        })

        /** Point a request at the machine's own workspace, through the relay. */
        const buildRelayArgs = (): any[] => {
          const machinePath = config.machineWorkspaceId
            ? rewriteMachineWorkspacePath(
                rewriteMachineWorkspaceParam(originalPath, config.machineWorkspaceId),
                config.machineWorkspaceId,
              )
            : originalPath
          const rewrittenPath = rewritePathForRemote(machinePath, config.remoteProxyBaseUrl!)
          const newArgs = [...args]
          newArgs[0] = rewrittenPath
          if (config.machineWorkspaceId && (prop === 'post' || prop === 'patch')) {
            newArgs[1] = rewriteMachineWorkspaceBody(newArgs[1], config.machineWorkspaceId)
          }
          const remoteHeaders: Record<string, string> = {
            'x-remote-control': 'true',
            ...(config.protocolVersion
              ? { 'x-remote-protocol-version': String(config.protocolVersion) }
              : {}),
            ...(config.syncVersion ? { 'x-sync-version': String(config.syncVersion) } : {}),
            ...(config.clientVersion ? { 'x-client-version': config.clientVersion } : {}),
          }
          if (prop === 'request' && typeof newArgs[1] === 'object' && newArgs[1] !== null) {
            newArgs[1] = { ...newArgs[1], headers: { ...(newArgs[1].headers || {}), ...remoteHeaders } }
          } else if (prop === 'post' || prop === 'patch') {
            newArgs[2] = { ...(newArgs[2] || {}), ...remoteHeaders }
          }
          return newArgs
        }

        if (!shouldRoute) {
          const cloudResult = (original as Function).apply(target, args)
          // A read of a machine workspace the cloud has no copy of comes back
          // `409 machine_copy_pending`. Read it from the machine instead of
          // showing "No access to this workspace" (SHO-241). One retry, and only
          // for a machine workspace: nothing else emits that code.
          if (
            !config.machineWorkspaceId ||
            !isRead ||
            !cloudResult ||
            typeof cloudResult.then !== 'function'
          ) {
            return cloudResult
          }
          return cloudResult.then(
            (response: unknown) => response,
            (error: unknown) => {
              if (!isMachineCopyPendingError(error)) throw error
              return (original as Function).apply(target, buildRelayArgs())
            },
          )
        }

        // Execute the rewritten request with error handling
        const machinePath = config.machineWorkspaceId
          ? rewriteMachineWorkspacePath(
              rewriteMachineWorkspaceParam(originalPath, config.machineWorkspaceId),
              config.machineWorkspaceId,
            )
          : originalPath
        const result = (original as Function).apply(target, buildRelayArgs())

        // If it's a promise (all HTTP methods return promises), add error handling
        if (result && typeof result.then === 'function') {
          return result.then(
            (response: unknown) => {
              // A request that came back means the machine is up: the banner
              // goes away on the first answer, not on the next 15s poll.
              if (config.machineWorkspaceId) config.onMachineState?.(null, machinePath)
              return response
            },
            (error: Error) => {
              // Notify caller about remote errors for fallback handling
              config.onRemoteError?.(error, machinePath)
              if (config.machineWorkspaceId) config.onMachineState?.(error, machinePath)
              throw error
            },
          )
        }

        return result
      }
    },
  }

  return new Proxy(http, handler)
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  REMOTE_ROUTED_PREFIXES,
  REMOTE_EXCLUDED_PATTERNS,
  ROUTE_TABLE,
  MACHINE_WORKSPACE_CLOUD_ONLY,
  MACHINE_WORKSPACE_OWNED,
  MACHINE_WORKSPACE_FAMILIES,
  MACHINE_WORKSPACE_LIVE_READS,
  type RouteTarget,
  type RouteEntry,
}
