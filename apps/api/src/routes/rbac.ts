// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * RBAC client surface.
 *
 * - GET    /workspaces/:id/permissions          caller's effective workspace access
 * - GET    /projects/:projectId/permissions     caller's effective project access
 * - PATCH  /projects/:projectId/visibility      workspace | restricted
 * - GET    /projects/:projectId/members         explicit project members + who
 *                                               has access through the workspace
 * - POST   /projects/:projectId/members         add a user (by userId or email);
 *                                               unknown emails get an invitation
 * - PATCH  /projects/:projectId/members/:id     change a project role
 * - DELETE /projects/:projectId/members/:id     remove a project role
 *
 * Project routes sit behind `requireProjectAccess` (read for GET, and
 * `project.members:manage` for writes to members/visibility); the handlers
 * additionally require `project.members:manage` for the member listing and
 * apply the no-escalation rule to role grants.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  canAssignProjectRole,
  isWorkspaceRole,
  permissionList,
  resolveAccess,
  toProjectRole,
  type ProjectRole,
} from '@shogo/authz'
import { z } from 'zod'
import { getAccess, principalOf } from '../lib/authz'
import { setProjectVisibility } from '../lib/authz/project-access'
import { parseBody } from '../lib/parse-body'
import { prisma } from '../lib/prisma'
import { invitationHooks } from '../generated/invitation.hooks'

const USER_SELECT = { id: true, name: true, email: true, image: true } as const

const ROLE_MESSAGE = 'role must be admin, member or viewer'
const projectRole = z.unknown().transform((value, ctx): ProjectRole => {
  const role = toProjectRole(value)
  if (!role) {
    ctx.addIssue({ code: 'custom', message: ROLE_MESSAGE })
    return z.NEVER
  }
  return role
})

const visibilityBody = z.object({
  visibility: z.enum(['workspace', 'restricted'], { message: "visibility must be 'workspace' or 'restricted'" }),
})

const addMemberBody = z
  .object({
    role: projectRole.optional().transform((role) => role ?? 'member'),
    userId: z.string().min(1).optional(),
    email: z.string().trim().toLowerCase().min(1).optional(),
  })
  .refine((b) => b.userId || b.email, { message: 'userId or email is required' })

const updateMemberBody = z.object({ role: projectRole })

function forbidden(c: Context, message: string) {
  return c.json({ error: { code: 'forbidden', message } }, 403)
}

async function requireMembersManage(c: Context, projectId: string) {
  const access = await getAccess(c, { projectId })
  return access.permissions.has('project.members:manage') ? access : null
}

export function rbacRoutes(): Hono {
  const router = new Hono()

  router.get('/workspaces/:id/permissions', async (c) => {
    const workspaceId = c.req.param('id')
    if (!principalOf(c).userId && principalOf(c).via !== 'tunnel') {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
    if (!workspace) return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)

    const access = await getAccess(c, { workspaceId })
    if (!access.permissions.has('workspace:read')) {
      return forbidden(c, 'Access denied to this workspace')
    }
    return c.json({
      ok: true,
      data: {
        workspaceId,
        role: access.workspaceRole,
        isSuperAdmin: access.isSuperAdmin,
        permissions: permissionList(access),
      },
    })
  })

  router.get('/projects/:projectId/permissions', async (c) => {
    const projectId = c.req.param('projectId')
    const access = await getAccess(c, { projectId })
    return c.json({
      ok: true,
      data: {
        projectId,
        workspaceId: access.workspaceId,
        visibility: access.visibility,
        workspaceRole: access.workspaceRole,
        projectRole: access.projectRole,
        isGuest: access.isGuest,
        isSuperAdmin: access.isSuperAdmin,
        permissions: permissionList(access),
      },
    })
  })

  router.patch('/projects/:projectId/visibility', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await requireMembersManage(c, projectId))) {
      return forbidden(c, 'Only project admins can change visibility')
    }
    const body = await parseBody(c, visibilityBody)
    if (!body.ok) return body.response
    const project = await setProjectVisibility(prisma, projectId, body.data.visibility, principalOf(c).userId)
    return c.json({ ok: true, data: { id: project.id, visibility: project.visibility } })
  })

  router.get('/projects/:projectId/members', async (c) => {
    const projectId = c.req.param('projectId')
    const access = await requireMembersManage(c, projectId)
    if (!access) return forbidden(c, 'Only project admins can view project access')

    const [projectRows, workspaceRows, invitations] = await Promise.all([
      prisma.member.findMany({
        where: { projectId },
        include: { user: { select: USER_SELECT } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.member.findMany({
        where: { workspaceId: access.workspaceId!, projectId: null },
        include: { user: { select: USER_SELECT } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.invitation.findMany({
        where: { projectId, status: 'pending' },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    const visibility = access.visibility ?? 'workspace'
    const wsRoleByUser = new Map<string, string>(workspaceRows.map((m) => [m.userId, m.role]))
    const projectRoleByUser = new Map<string, string>(projectRows.map((m) => [m.userId, m.role]))
    const effectiveRole = (userId: string) => {
      const workspaceRole = wsRoleByUser.get(userId)
      return resolveAccess({
        workspaceRole: isWorkspaceRole(workspaceRole) ? workspaceRole : null,
        project: { visibility, projectRole: toProjectRole(projectRoleByUser.get(userId)) },
      }).projectRole
    }

    return c.json({
      ok: true,
      data: {
        visibility,
        members: projectRows.map((m) => ({
          id: m.id,
          userId: m.userId,
          role: toProjectRole(m.role),
          isGuest: !wsRoleByUser.has(m.userId),
          user: m.user,
        })),
        workspaceMembers: workspaceRows.map((m) => ({
          userId: m.userId,
          workspaceRole: m.role,
          effectiveRole: effectiveRole(m.userId),
          user: m.user,
        })),
        invitations,
      },
    })
  })

  router.post('/projects/:projectId/members', async (c) => {
    const projectId = c.req.param('projectId')
    const access = await requireMembersManage(c, projectId)
    if (!access) return forbidden(c, 'Only project admins can add project members')

    const body = await parseBody(c, addMemberBody)
    if (!body.ok) return body.response
    const { role, email } = body.data
    if (!canAssignProjectRole(access, role)) {
      return forbidden(c, 'Cannot grant a role above your own')
    }

    let userId = body.data.userId
    if (!userId && email) {
      const user = await prisma.user.findFirst({ where: { email }, select: { id: true } })
      userId = user?.id
    }

    if (!userId) {
      return inviteByEmail(c, { projectId, workspaceId: access.workspaceId!, email: email!, role })
    }

    try {
      const member = await prisma.member.create({
        data: { userId, projectId, workspaceId: access.workspaceId!, role },
        include: { user: { select: USER_SELECT } },
      })
      return c.json({ ok: true, data: member }, 201)
    } catch (err) {
      if ((err as { code?: string } | null)?.code !== 'P2002') throw err
      return c.json({ error: { code: 'already_member', message: 'User already has a role on this project' } }, 409)
    }
  })

  router.patch('/projects/:projectId/members/:memberId', async (c) => {
    const projectId = c.req.param('projectId')
    const access = await requireMembersManage(c, projectId)
    if (!access) return forbidden(c, 'Only project admins can change project roles')

    const member = await prisma.member.findUnique({ where: { id: c.req.param('memberId') } })
    if (!member || member.projectId !== projectId) {
      return c.json({ error: { code: 'not_found', message: 'Project member not found' } }, 404)
    }
    const body = await parseBody(c, updateMemberBody)
    if (!body.ok) return body.response
    const { role } = body.data
    const current = toProjectRole(member.role) as ProjectRole
    if (!canAssignProjectRole(access, role) || !canAssignProjectRole(access, current)) {
      return forbidden(c, 'Cannot change a role above your own')
    }
    const updated = await prisma.member.update({
      where: { id: member.id },
      data: { role },
      include: { user: { select: USER_SELECT } },
    })
    return c.json({ ok: true, data: updated })
  })

  router.delete('/projects/:projectId/members/:memberId', async (c) => {
    const projectId = c.req.param('projectId')
    const access = await requireMembersManage(c, projectId)
    if (!access) return forbidden(c, 'Only project admins can remove project members')

    const member = await prisma.member.findUnique({ where: { id: c.req.param('memberId') } })
    if (!member || member.projectId !== projectId) {
      return c.json({ error: { code: 'not_found', message: 'Project member not found' } }, 404)
    }
    const current = toProjectRole(member.role) as ProjectRole
    if (!canAssignProjectRole(access, current)) {
      return forbidden(c, 'Cannot remove a role above your own')
    }
    await prisma.member.delete({ where: { id: member.id } })
    return c.json({ ok: true })
  })

  return router
}

/** Unknown email: create a project invitation through the invitation hooks. */
async function inviteByEmail(
  c: Context,
  input: { projectId: string; workspaceId: string; email: string; role: ProjectRole },
) {
  const principal = principalOf(c)
  const ctx = {
    body: input,
    params: {},
    query: {},
    userId: principal.userId,
    auth: principal,
    prisma,
  }
  const result = await invitationHooks.beforeCreate!(
    { email: input.email, projectId: input.projectId, workspaceId: input.workspaceId, role: input.role },
    ctx as any,
  )
  if (!result || !result.ok) {
    const code = result?.error?.code
    const status = code === 'forbidden' ? 403 : code === 'invitation_exists' ? 409 : 400
    return c.json({ error: result?.error }, status)
  }
  const invitation = await prisma.invitation.create({ data: result.data })
  await invitationHooks.afterCreate?.(invitation, ctx as any)
  return c.json({ ok: true, data: { invitation } }, 201)
}
