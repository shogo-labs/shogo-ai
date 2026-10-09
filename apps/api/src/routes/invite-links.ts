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
import { z } from 'zod'
import { getAccess, principalOf } from '../lib/authz'
import { parseBody } from '../lib/parse-body'
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

const createLinkBody = z
  .object({
    projectId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    role: z.string().optional(),
    email: z.string().trim().nullish(),
  })
  .refine((b) => b.projectId || b.workspaceId, { message: 'projectId or workspaceId required' })

const patchLinkBody = z.object({ enabled: z.boolean({ message: 'enabled (boolean) required' }) })

type ErrorStatus = 400 | 401 | 403 | 404

function fail(c: Context, status: ErrorStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

const unauthorized = (c: Context) => fail(c, 401, 'unauthorized', 'Authentication required')
const forbidden = (c: Context, message = 'You cannot manage invite links here') => fail(c, 403, 'forbidden', message)

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
    const userId = principalOf(c).userId
    if (!userId) return unauthorized(c)

    const parsed = await parseBody(c, createLinkBody)
    if (!parsed.ok) return parsed.response
    const body = parsed.data
    const { projectId, workspaceId } = body

    const scope = await linkScope({ projectId: projectId ?? null, workspaceId: workspaceId ?? null })
    if (!scope) return fail(c, 404, 'not_found', projectId ? 'Project not found' : 'Workspace not found')

    let role: 'admin' | 'member' | 'viewer'
    if (scope.projectId) {
      const projectRole = toProjectRole(body.role ?? 'member')
      if (!projectRole) return fail(c, 400, 'bad_request', 'role must be admin, member or viewer')
      const access = await getAccess(c, { projectId: scope.projectId })
      if (!canAssignProjectRole(access, projectRole)) {
        return forbidden(c, 'Only admins and owners can create invite links')
      }
      role = projectRole
    } else {
      const requested = body.role ?? 'member'
      if (!isWorkspaceRole(requested) || requested === 'owner') {
        return fail(c, 400, 'bad_request', 'role must be admin, member or viewer')
      }
      const access = await getAccess(c, { workspaceId: scope.workspaceId })
      if (!canAssignWorkspaceRole(access, requested)) {
        return forbidden(c, 'Only admins and owners can create invite links')
      }
      role = requested
    }

    const link = await prisma.inviteLink.create({
      data: { projectId: scope.projectId, workspaceId: scope.workspaceId, role, createdBy: userId },
    })

    if (body.email) {
      await config.afterCreate?.({
        link,
        userId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        email: body.email,
      })
    }

    return c.json({ ok: true, data: link })
  })

  router.get('/invite-links', async (c) => {
    if (!principalOf(c).userId) return unauthorized(c)

    const projectId = c.req.query('projectId')
    const workspaceId = c.req.query('workspaceId')
    if (!projectId && !workspaceId) return c.json({ ok: true, items: [] })

    const scope = await linkScope({ projectId: projectId ?? null, workspaceId: workspaceId ?? null })
    if (!scope || !(await canManageScope(c, scope))) return forbidden(c)

    const where = scope.projectId ? { projectId: scope.projectId } : { workspaceId: scope.workspaceId, projectId: null }
    const links = await prisma.inviteLink.findMany({ where, orderBy: { createdAt: 'desc' } })
    return c.json({ ok: true, items: links })
  })

  async function guardExisting(c: Context) {
    if (!principalOf(c).userId) return { error: unauthorized(c) }
    const existing = await prisma.inviteLink.findUnique({ where: { id: c.req.param('id') } })
    if (!existing) return { error: fail(c, 404, 'not_found', 'Invite link not found') }
    const scope = await linkScope(existing)
    // The creator keeps control of their link only while they can still manage members.
    if (!scope || !(await canManageScope(c, scope))) {
      return { error: forbidden(c) }
    }
    return { existing }
  }

  router.patch('/invite-links/:id', async (c) => {
    const guard = await guardExisting(c)
    if ('error' in guard) return guard.error
    const body = await parseBody(c, patchLinkBody)
    if (!body.ok) return body.response
    const link = await prisma.inviteLink.update({ where: { id: guard.existing.id }, data: { enabled: body.data.enabled } })
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
