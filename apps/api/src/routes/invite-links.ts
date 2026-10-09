// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Invite link management: create, list, toggle and delete shareable join
 * links for a workspace or project. Links are bearer credentials, so every
 * route requires the right to manage members of the link's scope.
 *
 * - Workspace links need `workspace.members:manage` and can grant at most the
 *   caller's own role, never `owner`.
 * - Project links need `project.members:manage` on the project and grant a
 *   project role (legacy `owner` is normalized to `admin`).
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  canAssignProjectRole,
  canAssignWorkspaceRole,
  isWorkspaceRole,
  toProjectRole,
} from '@shogo/authz'
import { getAccess } from '../lib/authz'
import { prisma } from '../lib/prisma'

export interface InviteLinkCreated {
  link: { id: string; token: string; role: string; projectId: string | null; workspaceId: string | null }
  userId: string
  workspaceId: string
  projectId: string | null
  email?: string
}

export interface InviteLinkRoutesConfig {
  /** Invitation email for `body.email`; cloud-only. */
  afterCreate?: (created: InviteLinkCreated) => Promise<void>
}

type Scope = { workspaceId: string; projectId: string | null }

async function canManageScope(c: Context, scope: Scope): Promise<boolean> {
  const access = await getAccess(c, scope.projectId ? { projectId: scope.projectId } : { workspaceId: scope.workspaceId })
  return access.permissions.has(scope.projectId ? 'project.members:manage' : 'workspace.members:manage')
}

async function linkScope(link: { projectId: string | null; workspaceId: string | null }): Promise<Scope | null> {
  if (link.projectId) {
    const project = await prisma.project.findUnique({ where: { id: link.projectId }, select: { workspaceId: true } })
    return project ? { workspaceId: project.workspaceId, projectId: link.projectId } : null
  }
  return link.workspaceId ? { workspaceId: link.workspaceId, projectId: null } : null
}

export function inviteLinkRoutes(config: InviteLinkRoutesConfig = {}): Hono {
  const router = new Hono()

  router.post('/invite-links', async (c) => {
    const userId = (c.get('auth') as any)?.userId
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)

    const body = await c.req.json().catch(() => ({}))
    const { projectId, workspaceId } = body as { projectId?: string; workspaceId?: string }
    if (!projectId && !workspaceId) {
      return c.json({ error: 'projectId or workspaceId required' }, 400)
    }

    const scope = await linkScope({ projectId: projectId ?? null, workspaceId: workspaceId ?? null })
    if (!scope) return c.json({ error: projectId ? 'Project not found' : 'Workspace not found' }, 404)

    let role: 'admin' | 'member' | 'viewer'
    if (scope.projectId) {
      const projectRole = toProjectRole(body.role ?? 'member')
      if (!projectRole) return c.json({ error: 'Invalid role' }, 400)
      const access = await getAccess(c, { projectId: scope.projectId })
      if (!canAssignProjectRole(access, projectRole)) {
        return c.json({ error: 'Only admins and owners can create invite links' }, 403)
      }
      role = projectRole
    } else {
      const requested = body.role ?? 'member'
      if (!isWorkspaceRole(requested) || requested === 'owner') {
        return c.json({ error: 'Invalid role' }, 400)
      }
      const access = await getAccess(c, { workspaceId: scope.workspaceId })
      if (!canAssignWorkspaceRole(access, requested)) {
        return c.json({ error: 'Only admins and owners can create invite links' }, 403)
      }
      role = requested
    }

    const link = await prisma.inviteLink.create({
      data: { projectId: scope.projectId, workspaceId: scope.workspaceId, role, createdBy: userId },
    })

    if (typeof body.email === 'string' && body.email) {
      await config.afterCreate?.({
        link: link as any,
        userId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        email: body.email,
      })
    }

    return c.json({ ok: true, data: link })
  })

  router.get('/invite-links', async (c) => {
    const userId = (c.get('auth') as any)?.userId
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)

    const projectId = c.req.query('projectId')
    const workspaceId = c.req.query('workspaceId')
    if (!projectId && !workspaceId) return c.json({ ok: true, items: [] })

    const scope = await linkScope({ projectId: projectId ?? null, workspaceId: workspaceId ?? null })
    if (!scope || !(await canManageScope(c, scope))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const where = scope.projectId ? { projectId: scope.projectId } : { workspaceId: scope.workspaceId, projectId: null }
    const links = await prisma.inviteLink.findMany({ where, orderBy: { createdAt: 'desc' } })
    return c.json({ ok: true, items: links })
  })

  async function guardExisting(c: Context) {
    const userId = (c.get('auth') as any)?.userId
    if (!userId) return { error: c.json({ error: 'Unauthorized' }, 401) }
    const existing = await prisma.inviteLink.findUnique({ where: { id: c.req.param('id') } })
    if (!existing) return { error: c.json({ error: 'Not found' }, 404) }
    const scope = await linkScope(existing)
    // The creator keeps control of their link only while they can still manage members.
    if (!scope || !(await canManageScope(c, scope))) {
      return { error: c.json({ error: 'Forbidden' }, 403) }
    }
    return { existing }
  }

  router.patch('/invite-links/:id', async (c) => {
    const guard = await guardExisting(c)
    if ('error' in guard) return guard.error
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled (boolean) required' }, 400)
    }
    const link = await prisma.inviteLink.update({ where: { id: guard.existing.id }, data: { enabled: body.enabled } })
    return c.json({ ok: true, data: link })
  })

  router.delete('/invite-links/:id', async (c) => {
    const guard = await guardExisting(c)
    if ('error' in guard) return guard.error
    await prisma.inviteLink.delete({ where: { id: guard.existing.id } })
    return c.json({ ok: true })
  })

  return router
}
