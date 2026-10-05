// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `POST /invite-links/:token/accept`: the signed-in user joins the link's
 * workspace (or project). Requires auth but not membership. Billing and
 * notification emails are cloud-only and supplied by the caller.
 */

import { Hono } from 'hono'
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

    const existingMember = await prisma.member.findFirst({
      where: {
        userId,
        ...(link.projectId ? { projectId: link.projectId } : { workspaceId: link.workspaceId }),
      },
    })
    if (existingMember) {
      return c.json({ ok: true, data: existingMember, alreadyMember: true })
    }

    const memberData: any = { userId, role: link.role }
    if (link.projectId) {
      memberData.projectId = link.projectId
      const project = await prisma.project.findUnique({ where: { id: link.projectId }, select: { workspaceId: true } })
      if (project) memberData.workspaceId = project.workspaceId
    } else {
      memberData.workspaceId = link.workspaceId
    }

    const member = await prisma.member.create({ data: memberData })
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
