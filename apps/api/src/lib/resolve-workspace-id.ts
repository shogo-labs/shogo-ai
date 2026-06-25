// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolve the workspace a request is acting on, so the home-region write router
 * can decide whether to handle it locally or proxy it to the workspace's home
 * region.
 *
 * Resolution order (cheapest / most-authoritative first):
 *   1. `c.get('workspaceId')` — already resolved upstream (requireProjectAccess).
 *   2. An explicit `workspaceId` in the URL (path segment or query).
 *   3. `/api/workspaces/:id` — the id *is* the workspace id.
 *   4. `auth.workspaceId` — set for API-key / runtime-token callers.
 *   5. A `projectId` in the URL/query → that project's workspace.
 *   6. A workspace-owned generated resource (`/api/<resource>/:id`) → look up
 *      the owning workspace from the row.
 *
 * Deliberately does NOT read the request body. The router buffers the body when
 * it proxies, and re-reading a consumed body stream is fragile; body-only
 * `workspaceId` (rare — mostly creates, which replicate safely by unique id)
 * falls through to "handle locally".
 *
 * Returns the workspace id, or null when the request isn't workspace-scoped
 * (identity/global writes like users, notifications, auth) — those stay local.
 */

import type { Context } from 'hono'
import { prisma } from './prisma'

const db = prisma as any

/** Cache a resolved workspace id on the context for downstream reuse. */
function cache(c: Context, workspaceId: string): string {
  c.set('workspaceId', workspaceId)
  return workspaceId
}

/** `/api/foo/bar` → `['foo', 'bar']`; tolerant of a missing `/api` prefix. */
function apiSegments(pathname: string): string[] {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'api') parts.shift()
  return parts
}

async function projectWorkspace(projectId: string): Promise<string | null> {
  const row = await db.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })
  return row?.workspaceId ?? null
}

async function chatSessionWorkspace(sessionId: string): Promise<string | null> {
  const s = await db.chatSession.findUnique({
    where: { id: sessionId },
    select: { workspaceId: true, contextType: true, contextId: true },
  })
  if (!s) return null
  if (s.workspaceId) return s.workspaceId
  if (s.contextType === 'project' && s.contextId) return projectWorkspace(s.contextId)
  return null
}

type Lookup = (id: string) => Promise<string | null>

/**
 * Prisma client accessor names (camelCase, e.g. `starredProject`) of every
 * model this resolver can resolve to a workspace. Populated as a side effect of
 * building `RESOURCE_LOOKUPS` (via `directWs`/`viaProject`) plus the custom
 * chain lookups below. Consumed by the resolver-coverage CI guard
 * (`__tests__/resolver-coverage.test.ts`) so a newly added workspace-owned
 * model can't silently become an unrouted (conflict-prone) write.
 */
const workspaceResolvedModels = new Set<string>(['project'])

/** Generated/handwritten resources whose row carries a direct `workspaceId`. */
const directWs = (model: string): Lookup => {
  workspaceResolvedModels.add(model)
  return async (id) => {
    const row = await db[model].findUnique({ where: { id }, select: { workspaceId: true } })
    return row?.workspaceId ?? null
  }
}

/** Resources whose workspace is reached through a `projectId` column. */
const viaProject = (model: string): Lookup => {
  workspaceResolvedModels.add(model)
  return async (id) => {
    const row = await db[model].findUnique({ where: { id }, select: { projectId: true } })
    return row?.projectId ? projectWorkspace(row.projectId) : null
  }
}

/**
 * Map of `/api/<segment>/:id` → how to find that row's workspace. Only
 * workspace-owned resources are listed; anything absent (users, notifications,
 * auth, …) is treated as identity/global and handled locally.
 */
const RESOURCE_LOOKUPS: Record<string, Lookup> = {
  projects: directWs('project'),
  'starred-projects': directWs('starredProject'),
  members: directWs('member'),
  'billing-accounts': directWs('billingAccount'),
  invitations: directWs('invitation'),
  folders: directWs('folder'),
  subscriptions: directWs('subscription'),
  'usage-wallets': directWs('usageWallet'),
  'usage-events': directWs('usageEvent'),
  'workspace-grants': directWs('workspaceGrant'),
  'chat-sessions': (id) => chatSessionWorkspace(id),
  'project-folders': viaProject('projectFolder'),
  'feature-sessions': viaProject('featureSession'),
  'chat-session-projects': viaProject('chatSessionProject'),
  'chat-messages': async (id) => {
    const msg = await db.chatMessage.findUnique({ where: { id }, select: { sessionId: true } })
    return msg?.sessionId ? chatSessionWorkspace(msg.sessionId) : null
  },
  'tool-call-logs': async (id) => {
    const log = await db.toolCallLog.findUnique({ where: { id }, select: { chatSessionId: true } })
    return log?.chatSessionId ? chatSessionWorkspace(log.chatSessionId) : null
  },
  // Handwritten (non-generated) workspace-owned resources.
  'api-keys': directWs('apiKey'),
  instances: directWs('instance'),
  meetings: directWs('meeting'),
}

// Custom chain lookups above resolve these models without going through
// `directWs`/`viaProject`, so record them explicitly for the coverage guard.
for (const m of ['chatSession', 'chatMessage', 'toolCallLog']) {
  workspaceResolvedModels.add(m)
}

/** @see workspaceResolvedModels */
export const WORKSPACE_RESOLVED_MODELS: ReadonlySet<string> = workspaceResolvedModels

/** Path segments that look like an id but are reserved keywords, not row ids. */
const RESERVED_RESOURCE_IDS = new Set(['import', 'validate', 'heartbeat'])

export async function resolveWorkspaceIdForRequest(c: Context): Promise<string | null> {
  const cached = c.get('workspaceId') as string | undefined
  if (cached) return cached

  const auth = c.get('auth') as { workspaceId?: string } | undefined
  const pathname = new URL(c.req.url).pathname
  const seg = apiSegments(pathname)

  // 2. Explicit workspaceId in URL/query.
  const explicit = c.req.query('workspaceId')
  if (explicit) return cache(c, explicit)

  // 3. /api/workspaces/:id — the id is the workspace.
  if (seg[0] === 'workspaces' && seg[1] && !RESERVED_RESOURCE_IDS.has(seg[1])) {
    return cache(c, seg[1])
  }

  // 5a. /api/projects/:projectId/... (path) — resolve before falling back to
  //     auth.workspaceId so session callers get the precise workspace.
  const projectQuery = c.req.query('projectId')

  // 4. API-key / runtime-token workspace scope.
  if (auth?.workspaceId) return cache(c, auth.workspaceId)

  // 5b. projectId from the path or query.
  if (seg[0] === 'projects' && seg[1] && !RESERVED_RESOURCE_IDS.has(seg[1])) {
    const ws = await projectWorkspace(seg[1])
    if (ws) return cache(c, ws)
  }
  if (projectQuery) {
    const ws = await projectWorkspace(projectQuery)
    if (ws) return cache(c, ws)
  }

  // 6. Workspace-owned generated/handwritten resource by :id.
  if (seg.length >= 2 && seg[1] && !RESERVED_RESOURCE_IDS.has(seg[1])) {
    const lookup = RESOURCE_LOOKUPS[seg[0]]
    if (lookup) {
      const ws = await lookup(seg[1])
      if (ws) return cache(c, ws)
    }
  }

  return null
}
