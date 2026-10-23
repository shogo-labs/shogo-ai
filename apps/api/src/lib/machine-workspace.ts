// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guards for a workspace whose rows live on a paired desktop (SHO-185).
 *
 * `Workspace.machineInstanceId` marks such a workspace. The cloud holds a copy of
 * its rows purely for reads — the desktop is the only writer. So:
 *
 *   • **Cloud write routes refuse them.** A non-GET from the Studio that names a
 *     machine workspace answers `409 machine_workspace_write_via_tunnel`; the
 *     Studio's own client sends mutations through the tunnel, so a cloud write
 *     reaching a route is a bug, not a feature. The ingest path
 *     (`POST /api/machines/:id/sync`) is the single exception and is exempt.
 *   • **Cloud background work skips them.** Every scheduler, trigger, wake,
 *     digest and meter selects workspaces through `withCloudWorkspaces` /
 *     `CLOUD_WORKSPACE_ONLY`, so a copied workspace with a due schedule does not
 *     fire on the cloud as well as on the desktop (which already runs it).
 *   • **Lists that mean "my cloud workspaces" exclude them.** The switcher
 *     reaches the copy through `GET /machines` instead.
 */

import type { Context, Next } from 'hono'
import { prisma } from './prisma'

/** Prisma `where` fragment selecting only real cloud workspaces. */
export const CLOUD_WORKSPACE_ONLY = { machineInstanceId: null } as const

/** Prisma `where` fragment selecting only machine copies. */
export const MACHINE_WORKSPACE_ONLY = { machineInstanceId: { not: null } } as const

export function isMachineWorkspace(
  workspace: { machineInstanceId?: string | null } | null | undefined,
): boolean {
  return Boolean(workspace?.machineInstanceId)
}

/** The tag for a workspace id, memoized per request (the guard runs once). */
export async function machineInstanceIdOf(workspaceId: string): Promise<string | null> {
  if (!workspaceId) return null
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { machineInstanceId: true },
  })
  return workspace?.machineInstanceId ?? null
}

/**
 * Merge `{ machineInstanceId: null }` into a `where` without disturbing what the
 * caller already narrowed it to.
 */
export function withCloudWorkspaces<T extends Record<string, unknown>>(where: T): T & {
  machineInstanceId: null
} {
  return { ...where, ...CLOUD_WORKSPACE_ONLY }
}

/**
 * Ids of every machine copy.
 *
 * For a worker whose table carries `workspaceId` as a plain column — no
 * relation to filter through — this is the whole guard: one indexed read of the
 * (tiny) set of paired machines, then `workspaceId: { notIn: ids }`. Leaving the
 * filter off when nothing is paired keeps the query plan unchanged for everyone
 * who has no machine.
 */
export async function machineWorkspaceIds(): Promise<string[]> {
  const rows = await prisma.workspace.findMany({
    where: MACHINE_WORKSPACE_ONLY,
    select: { id: true },
  })
  return rows.map((row) => row.id)
}

/** `{ workspaceId: { notIn: … } }`, or nothing at all when no machine is paired. */
export async function notMachineWorkspaceWhere(): Promise<Record<string, unknown>> {
  const ids = await machineWorkspaceIds()
  return ids.length ? { workspaceId: { notIn: ids } } : {}
}

export function machineWorkspaceWriteError(machineInstanceId: string | null) {
  return {
    error: {
      code: 'machine_workspace_write_via_tunnel',
      message:
        'This workspace runs on a paired machine; changes have to go through the tunnel so the desktop stays the writer',
      machineInstanceId,
    },
  }
}

/**
 * Which workspace (if any) a request names. Covers the shapes the Studio uses:
 * the workspace in the path, `workspaceId` in the body or the query, and the
 * common top-level resources whose row carries its workspace.
 *
 * Returns null when it cannot tell, in which case the request is left alone —
 * this is a safety net for the writes we *can* see, not an authorization check.
 */
export async function resolveTouchedWorkspaceId(c: Context): Promise<string | null> {
  const path = c.req.path

  const workspaceScoped = path.match(/^\/api\/workspaces\/([^/?#]+)/)
  if (workspaceScoped) {
    const candidate = workspaceScoped[1]
    // `/api/workspaces` itself, or a sub-path that is not an id (there are none
    // today). An id never contains a second segment.
    if (candidate && candidate !== 'machine-workspaces') return candidate
  }

  const resource = path.match(
    /^\/api\/(projects|chat-sessions|chat-messages|boards|work-items|goals|agent-schedules|conversations|meetings|folders|feature-sessions)\/([^/?#]+)/,
  )
  if (resource) {
    const workspaceId = await workspaceOfResource(resource[1], resource[2])
    if (workspaceId) return workspaceId
  }

  const queryWorkspace = new URL(c.req.url).searchParams.get('workspaceId')
  if (queryWorkspace) return queryWorkspace

  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const body = await peekBodyWorkspaceId(c)
    if (body) return body
  }

  return null
}

/** One lookup per resource type; each select is a single indexed column read. */
async function workspaceOfResource(resource: string, id: string): Promise<string | null> {
  try {
    switch (resource) {
      case 'projects': {
        const row = await prisma.project.findUnique({
          where: { id },
          select: { workspaceId: true },
        })
        return row?.workspaceId ?? null
      }
      case 'chat-sessions': {
        const row = await prisma.chatSession.findUnique({
          where: { id },
          select: { workspaceId: true },
        })
        return row?.workspaceId ?? null
      }
      case 'boards': {
        const row = await prisma.board.findUnique({ where: { id }, select: { workspaceId: true } })
        return row?.workspaceId ?? null
      }
      case 'work-items': {
        const row = await prisma.workItem.findUnique({
          where: { id },
          select: { workspaceId: true },
        })
        return row?.workspaceId ?? null
      }
      case 'goals': {
        const row = await prisma.goal.findUnique({ where: { id }, select: { workspaceId: true } })
        return row?.workspaceId ?? null
      }
      case 'agent-schedules': {
        const row = await prisma.agentSchedule.findUnique({
          where: { id },
          select: { workspaceId: true },
        })
        return row?.workspaceId ?? null
      }
      case 'conversations':
      case 'meetings':
      case 'feature-sessions':
      case 'folders': {
        const model = { conversations: 'conversation', meetings: 'meeting', 'feature-sessions': 'featureSession', folders: 'folder' }[resource] as
          | 'conversation'
          | 'meeting'
          | 'featureSession'
          | 'folder'
          | undefined
        if (!model) return null
        const row = await (prisma as any)[model].findUnique({
          where: { id },
          select: { workspaceId: true },
        })
        return row?.workspaceId ?? null
      }
      default:
        return null
    }
  } catch {
    // A malformed id, or a table the caller cannot read: not this guard's job.
    return null
  }
}

/** `workspaceId` from a JSON body, without consuming the body the route needs. */
async function peekBodyWorkspaceId(c: Context): Promise<string | null> {
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.includes('application/json')) return null
  try {
    const clone = c.req.raw.clone()
    const body = (await clone.json()) as Record<string, unknown> | null
    const workspaceId = body?.workspaceId
    return typeof workspaceId === 'string' && workspaceId ? workspaceId : null
  } catch {
    return null
  }
}

/** Paths that legitimately write machine rows, and must not be blocked. */
function isExempt(c: Context): boolean {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return true
  // The ingest itself, and the machine relay (which writes nothing here).
  if (/^\/api\/machines\/[^/]+\/(sync|w\/)/.test(c.req.path)) return true
  // Desktop-only local routes never run in the cloud, but they do run in the
  // desktop's own process where every workspace is local.
  if (c.req.path.startsWith('/api/local/')) return true
  return false
}

/**
 * Middleware: refuse a cloud write that names a machine workspace.
 *
 * Mounted globally for `/api/*`, before the routes, so a new write route is
 * covered the day it is added rather than the day somebody remembers.
 */
export function machineWorkspaceWriteGuard() {
  return async (c: Context, next: Next) => {
    if (isExempt(c)) return next()
    const workspaceId = await resolveTouchedWorkspaceId(c)
    if (!workspaceId) return next()
    const machineInstanceId = await machineInstanceIdOf(workspaceId)
    if (!machineInstanceId) return next()
    return c.json(machineWorkspaceWriteError(machineInstanceId), 409)
  }
}
