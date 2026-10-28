// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `GET /api/invitations/:id/info` — the pre-auth context an emailed invitation
 * link needs, served to `/invitations/<id>/accept` on the web app.
 *
 * The route is public (see `PUBLIC_PATTERNS` in `../middleware/auth`): the
 * invitation id is an unguessable uuid and the accept page has to render
 * *before* the invitee signs in. That is why the payload deliberately carries
 * no email address — only what the page shows (workspace/project name, role,
 * status) plus the ids the accept path needs to create the member row.
 *
 * It lives beside the other invitation routers rather than inline in
 * `server.ts` so the handler the app runs is the one the tests drive.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'

export interface InvitationInfo {
  role: string
  status: string
  expired: boolean
  workspaceId: string | null
  projectId: string | null
  workspaceName: string | null
  projectName: string | null
}

export interface InvitationInfoRoutesConfig {
  /** DB handle for tests; defaults to the app client. */
  prisma?: any
}

export function invitationInfoRoutes(config: InvitationInfoRoutesConfig = {}) {
  const db = config.prisma ?? prisma
  const app = new Hono()

  app.get('/:id/info', async (c) => {
    const id = c.req.param('id')
    const invitation = await db.invitation.findUnique({
      where: { id },
      select: {
        role: true,
        status: true,
        expiresAt: true,
        workspaceId: true,
        projectId: true,
        workspace: { select: { name: true } },
      },
    })

    if (!invitation) {
      return c.json({ error: { code: 'not_found', message: 'Invitation not found' } }, 404)
    }

    // `Invitation` has no project relation, so the name comes from the project
    // row itself (project-scoped invites are the ones that need it).
    const project = invitation.projectId
      ? await db.project.findUnique({
          where: { id: invitation.projectId },
          select: { name: true },
        })
      : null

    const data: InvitationInfo = {
      role: invitation.role,
      status: invitation.status,
      expired: invitation.expiresAt ? new Date(invitation.expiresAt) < new Date() : false,
      workspaceId: invitation.workspaceId ?? null,
      projectId: invitation.projectId ?? null,
      workspaceName: invitation.workspace?.name ?? null,
      projectName: project?.name ?? null,
    }

    return c.json({ ok: true, data })
  })

  return app
}
