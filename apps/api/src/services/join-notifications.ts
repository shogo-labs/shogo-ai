// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The one place a workspace join sends mail (SHO-51).
 *
 * Invitations and invite links both create a `Member`, and both notify from two
 * independent layers used to reach the same person twice — "X joined" from the
 * member hook and "X accepted your invitation" from the invitation hook / accept
 * route. Recipients are resolved once here, keyed by address, so an inviter-owner
 * gets exactly one mail: the "accepted" one, because they already know they
 * invited. Everyone else who owns the workspace gets "joined".
 *
 * Called from `onWorkspaceMemberJoined` and only for a new `member.joined`
 * event, so a replayed accept sends nothing.
 */

import { prisma } from '../lib/prisma'
import { sendInviteAcceptedEmail, sendMemberJoinedEmail } from './email.service'

type JoinMail = 'invite-accepted' | 'member-joined'

export interface JoinMailSenders {
  inviteAccepted: typeof sendInviteAcceptedEmail
  memberJoined: typeof sendMemberJoinedEmail
}

type Db = any

let injectedSenders: JoinMailSenders | null = null

/**
 * Test seam: route join mail through `senders` instead of the real mailer, so a
 * test never has to `mock.module('../services/email.service')` (a process-global
 * that leaks into whatever file `bun test` loads next). `null` restores the real
 * senders.
 */
export function setJoinMailSenders(senders: JoinMailSenders | null): void {
  injectedSenders = senders
}

function mailSenders(): JoinMailSenders {
  return injectedSenders ?? { inviteAccepted: sendInviteAcceptedEmail, memberJoined: sendMemberJoinedEmail }
}

function frontendUrl(): string {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
}

/**
 * The `People` tab of the end-user Settings page.
 *
 * `/settings` is the user's own Settings screen; only after SHO-110 does a
 * direct GET of it resolve there, because the admin AI/provider screen moved to
 * `/admin/settings` (two files used to claim `/settings`, and the admin console
 * won — every emailed link bounced to `/projects`). The path is pinned twice:
 * here by `apps/api/src/__tests__/join-notification-settings-url.test.ts`, and
 * against the route tree by `apps/mobile/test/route-path-collisions.test.ts`.
 * Keep it a bare `/settings`; do not route it through `/c/settings`.
 */
export function settingsPeoplePath(): string {
  return '/settings?tab=people'
}

/** Absolute link to Settings → People, the only place join mail points. */
export function settingsPeopleUrl(): string {
  return `${frontendUrl()}${settingsPeoplePath()}`
}

/** The accepted workspace invitation behind this membership, if there is one. */
async function resolveInviterId(db: Db, workspaceId: string, email: string | null | undefined): Promise<string | null> {
  if (!email) return null
  const invitation = await db.invitation.findFirst({
    where: {
      workspaceId,
      status: 'accepted',
      invitedBy: { not: null },
      email: { in: [email, email.toLowerCase()] },
    },
    orderBy: { updatedAt: 'desc' },
    select: { invitedBy: true },
  })
  return invitation?.invitedBy ?? null
}

export async function notifyWorkspaceJoined(input: {
  workspaceId: string
  userId: string
  role?: string | null
  /** Who invited/created the link, when the caller knows. Otherwise resolved from the accepted invitation. */
  invitedBy?: string | null
}, dbArg?: Db): Promise<void> {
  const db: Db = dbArg ?? prisma
  try {
    const [user, workspace, owners] = await Promise.all([
      db.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } }),
      db.workspace.findUnique({ where: { id: input.workspaceId }, select: { name: true } }),
      db.member.findMany({
        where: { workspaceId: input.workspaceId, role: 'owner', projectId: null, userId: { not: input.userId } },
        include: { user: { select: { email: true } } },
      }),
    ])
    if (!workspace) return

    const joinedEmail = (user?.email ?? '').toLowerCase() || null
    const inviterId = input.invitedBy ?? (await resolveInviterId(db, input.workspaceId, user?.email))

    // One entry per address: the inviter's mail wins over the generic one.
    const recipients = new Map<string, JoinMail>()
    const add = (email: string | null | undefined, mail: JoinMail) => {
      const key = (email ?? '').toLowerCase()
      if (!key || key === joinedEmail) return
      if (recipients.has(key)) return
      recipients.set(key, mail)
    }
    for (const owner of owners) {
      add(owner.user?.email, owner.userId === inviterId ? 'invite-accepted' : 'member-joined')
    }
    if (inviterId && inviterId !== input.userId) {
      const inviter = await db.user.findUnique({ where: { id: inviterId }, select: { email: true } })
      add(inviter?.email, 'invite-accepted')
    }
    if (recipients.size === 0) return

    const memberName = user?.name || user?.email || 'A new member'
    const memberEmail = user?.email || ''
    const dashboardUrl = settingsPeopleUrl()
    const senders = mailSenders()

    await Promise.allSettled(
      [...recipients].map(([email, mail]) =>
        mail === 'invite-accepted'
          ? senders.inviteAccepted({
              to: email,
              inviteeName: memberName,
              inviteeEmail: memberEmail,
              resourceName: workspace.name,
              resourceType: 'workspace',
              dashboardUrl,
            })
          : senders.memberJoined({
              to: email,
              memberName,
              memberEmail,
              workspaceName: workspace.name,
              role: input.role || 'member',
              dashboardUrl,
            }),
      ),
    )
  } catch (error) {
    console.error('[JoinNotifications] send failed:', error instanceof Error ? error.message : error)
  }
}

/**
 * A project invite (link or email invitation) is a project-scoped (guest)
 * membership: it has no `member.joined` event and no owner mail, so
 * `notifyWorkspaceJoined` never runs for it — the inviter still gets their one
 * "accepted" mail from here.
 */
async function sendProjectAccepted(
  db: Db,
  opts: { invitedBy: string; projectId: string; invitee: { userId?: string; email?: string } },
): Promise<void> {
  const [creator, project] = await Promise.all([
    db.user.findUnique({ where: { id: opts.invitedBy }, select: { email: true } }),
    db.project.findUnique({ where: { id: opts.projectId }, select: { name: true } }),
  ])
  if (!creator?.email || !project?.name) return

  const acceptingUser = opts.invitee.userId
    ? await db.user.findUnique({ where: { id: opts.invitee.userId }, select: { name: true, email: true } })
    : await db.user.findFirst({
        where: { email: (opts.invitee.email ?? '').toLowerCase() },
        select: { name: true, email: true },
      })

  await mailSenders().inviteAccepted({
    to: creator.email,
    inviteeName: acceptingUser?.name || acceptingUser?.email || opts.invitee.email || 'A new member',
    inviteeEmail: acceptingUser?.email || opts.invitee.email || '',
    resourceName: project.name,
    resourceType: 'project',
    dashboardUrl: settingsPeopleUrl(),
  })
}

export async function notifyProjectLinkAccepted(input: {
  link: { createdBy?: string | null; projectId?: string | null }
  userId: string
}, dbArg?: Db): Promise<void> {
  const db: Db = dbArg ?? prisma
  try {
    const { createdBy, projectId } = input.link
    if (!createdBy || !projectId) return
    await sendProjectAccepted(db, { invitedBy: createdBy, projectId, invitee: { userId: input.userId } })
  } catch (error) {
    console.error('[JoinNotifications] project link send failed:', error instanceof Error ? error.message : error)
  }
}

/** The `Invitation` counterpart, for `PATCH /api/invitations/:id` accepting a project invite. */
export async function notifyProjectInvitationAccepted(input: {
  invitedBy: string
  projectId: string
  email: string
}, dbArg?: Db): Promise<void> {
  const db: Db = dbArg ?? prisma
  try {
    await sendProjectAccepted(db, {
      invitedBy: input.invitedBy,
      projectId: input.projectId,
      invitee: { email: input.email },
    })
  } catch (error) {
    console.error('[JoinNotifications] project invitation send failed:', error instanceof Error ? error.message : error)
  }
}
