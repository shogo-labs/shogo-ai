// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `POST /invite-links/:token/accept`: the signed-in user joins the link's
 * workspace (or project). Requires auth but not membership. Billing and
 * notification emails are cloud-only and supplied by the caller.
 */

import { Hono } from 'hono'
import { isWorkspaceRole, toProjectRole } from '@shogo/authz'
import { prisma } from '../lib/prisma'

export interface InviteLinkAccepted {
  link: { id: string; role: string; createdBy: string | null; projectId: string | null; workspaceId: string | null }
  member: { id: string; role: string; userId: string; workspaceId: string | null; projectId: string | null }
  userId: string
  workspaceId: string | null
}

export interface InviteLinkAcceptConfig {
  resolveUserId: (c: any) => Promise<string | null> | string | null
  /** Seat sync and emails; runs after the membership exists. */
  afterAccept?: (accepted: InviteLinkAccepted) => Promise<void>
}

export function inviteLinkAcceptRoutes(config: InviteLinkAcceptConfig): Hono {
  const router = new Hono()

  router.post('/invite-links/:token/accept', async (c) => {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)

    const link = await prisma.inviteLink.findUnique({ where: { token: c.req.param('token') } })
    if (!link || !link.enabled) {
      return c.json({ error: 'Invite link not found or disabled' }, 404)
    }
    if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
      return c.json({ error: 'Invite link has expired' }, 410)
    }

    let workspaceId = link.workspaceId
    if (link.projectId) {
      const project = await prisma.project.findUnique({ where: { id: link.projectId }, select: { workspaceId: true } })
      if (!project) return c.json({ error: 'Invite link not found or disabled' }, 404)
      workspaceId = project.workspaceId
    }

    const existingMember = await prisma.member.findFirst({
      where: {
        userId,
        ...(link.projectId ? { projectId: link.projectId } : { workspaceId, projectId: null }),
      },
    })
    if (existingMember) {
      return c.json({ ok: true, data: existingMember, alreadyMember: true })
    }

    // Project links grant a project-scoped (guest) row only; links can never mint owners.
    const memberData: any = link.projectId
      ? { userId, workspaceId, projectId: link.projectId, role: toProjectRole(link.role) ?? 'viewer' }
      : {
          userId,
          workspaceId,
          role: isWorkspaceRole(link.role) && link.role !== 'owner' ? link.role : 'member',
        }

    let member
    try {
      member = await prisma.member.create({ data: memberData })
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err
      const raced = await prisma.member.findFirst({
        where: link.projectId ? { userId, projectId: link.projectId } : { userId, workspaceId, projectId: null },
      })
      return c.json({ ok: true, data: raced, alreadyMember: true })
    }
    await prisma.inviteLink.update({ where: { id: link.id }, data: { useCount: { increment: 1 } } })

    if (memberData.workspaceId && !memberData.projectId) {
      const { onWorkspaceMemberJoined } = await import('../services/workspace-events')
      await onWorkspaceMemberJoined({
        workspaceId: memberData.workspaceId,
        userId,
        memberId: member.id,
        role: member.role,
        source: 'invite_link',
      })
    }

    await config.afterAccept?.({ link: link as any, member: member as any, userId, workspaceId: memberData.workspaceId ?? null })
      .catch((err) => console.error('[InviteLinks] post-accept work failed:', err?.message ?? err))

    return c.json({ ok: true, data: member })
  })

  return router
}
