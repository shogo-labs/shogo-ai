// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `POST /invitations/:id/resend` (SHO-454).
 *
 * Re-sends a pending invitation's email and pushes its `expiresAt` out another
 * seven days, so "already invited · Resend" in the invite dialog is one call
 * instead of a delete-and-recreate that would change the accept link.
 *
 * Allowed for a manager (`workspace.members:manage` / `project.members:manage`)
 * and for the invitation's own `invitedBy` while the workspace's invite policy
 * still lets them invite. A Viewer, or an Editor on an `admins`-only
 * workspace, gets a 403.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { getAccess, principalOf, type AccessContext } from '../lib/authz'
import { prisma } from '../lib/prisma'
import { canInviteToWorkspace } from '../lib/workspace-invite-policy'
import { INVITATION_ACCEPT_PATH } from '../lib/invitation-path'
import { getFrontendUrl } from '../lib/cloud-urls'
import { sendInvitationEmail, sendProjectInviteEmail } from '../services/email.service'

const RESEND_WINDOW_DAYS = 7

function fail(c: Context, status: 400 | 401 | 403 | 404 | 409, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

export function invitationResendRoutes(): Hono {
  const router = new Hono()

  router.post('/invitations/:id/resend', async (c) => {
    const userId = principalOf(c).userId
    if (!userId) return fail(c, 401, 'unauthorized', 'Authentication required')

    const invitation = await prisma.invitation.findUnique({ where: { id: c.req.param('id') } })
    if (!invitation) return fail(c, 404, 'not_found', 'Invitation not found')
    if (invitation.status !== 'pending') {
      return fail(c, 409, 'not_pending', 'Only a pending invitation can be resent')
    }

    const allowed = await canResend(c, userId, invitation)
    if (!allowed) return fail(c, 403, 'forbidden', 'You cannot resend this invitation')

    const expiresAt = new Date(Date.now() + RESEND_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const [workspace, project, inviter] = await Promise.all([
      invitation.workspaceId
        ? prisma.workspace.findUnique({ where: { id: invitation.workspaceId }, select: { name: true } })
        : null,
      invitation.projectId
        ? prisma.project.findUnique({ where: { id: invitation.projectId }, select: { name: true } })
        : null,
      invitation.invitedBy
        ? prisma.user.findUnique({ where: { id: invitation.invitedBy }, select: { name: true, email: true } })
        : null,
    ])

    const resourceName = project?.name || workspace?.name
    if (!resourceName) return fail(c, 404, 'not_found', 'Workspace or project not found')

    const acceptUrl = `${getFrontendUrl()}${INVITATION_ACCEPT_PATH(invitation.id)}`
    const inviterName = inviter?.name || inviter?.email || 'A team member'

    const emailResult =
      invitation.projectId && project?.name
        ? await sendProjectInviteEmail({
            to: invitation.email,
            inviterName,
            projectName: project.name,
            workspaceName: workspace?.name,
            role: invitation.role,
            acceptUrl,
          })
        : await sendInvitationEmail({
            to: invitation.email,
            inviterName,
            workspaceName: workspace?.name || resourceName,
            role: invitation.role,
            acceptUrl,
          })

    const updated = await prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        expiresAt,
        emailStatus: emailResult.success ? 'sent' : 'failed',
        emailSentAt: emailResult.success ? new Date() : null,
        emailError: emailResult.error || null,
      },
    })

    if (!emailResult.success) {
      return c.json(
        { error: { code: 'email_failed', message: emailResult.error || 'The invitation email could not be sent' } },
        502,
      )
    }
    return c.json({ ok: true, data: updated })
  })

  return router
}

async function canResend(
  c: Context,
  userId: string,
  invitation: { workspaceId: string | null; projectId: string | null; invitedBy: string | null; role: string },
): Promise<boolean> {
  if (invitation.projectId) {
    const access = await getAccess(c, { projectId: invitation.projectId })
    return canResendInvitation({ access, userId, invitation, workspace: null })
  }
  if (!invitation.workspaceId) return false

  const access = await getAccess(c, { workspaceId: invitation.workspaceId })
  const workspace = access.permissions.has('workspace.members:manage')
    ? null
    : await prisma.workspace.findUnique({
        where: { id: invitation.workspaceId },
        select: { invitePolicy: true },
      })
  return canResendInvitation({ access, userId, invitation, workspace })
}

/**
 * Who may resend an invitation (SHO-454). A manager always may. Otherwise only
 * the invitation's own author, and only while the workspace's invite policy
 * still lets them invite with that role — so an Editor loses the button the
 * moment an admin switches the policy to `admins`, and a Viewer never has it.
 */
export function canResendInvitation(opts: {
  access: AccessContext
  userId: string
  invitation: { projectId: string | null; invitedBy: string | null; role: string }
  /** The workspace's policy row; only read when the caller is not a manager. */
  workspace: { invitePolicy: string | null } | null
}): boolean {
  const { access, userId, invitation, workspace } = opts
  if (invitation.projectId) return access.permissions.has('project.members:manage')
  if (access.permissions.has('workspace.members:manage')) return true
  if (invitation.invitedBy !== userId) return false
  return canInviteToWorkspace(access, workspace, invitation.role)
}
