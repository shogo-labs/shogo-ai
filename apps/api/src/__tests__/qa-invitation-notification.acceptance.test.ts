// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-84 acceptance — the invitee is actually told, once.
 *
 * The dev's `invitation-notification.hooks.test.ts` mocks `createNotification`,
 * so it can only prove the hook *calls* it with a `dedupeKey`. The AC is about
 * what lands in the database ("exactly one `invitation_pending` notification …
 * re-running `afterCreate` for the same invite does not double-insert"), and
 * that dedupe lives inside the real `createNotification`. This spec therefore
 * runs the hook against a real SQLite database with the real notification
 * service, mocking only the two things that must never leave the process: the
 * email and the push.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupChannelsTestDb } from './helpers/channels-test-db'
import { INVITATION_ACCEPT_PATH } from '../lib/invitation-path'

const { dir } = setupChannelsTestDb()

const emails: any[] = []
const pushes: any[] = []

mock.module('../services/email.service', () => ({
  sendInvitationEmail: async (params: any) => {
    emails.push({ kind: 'workspace', ...params })
    return { success: true }
  },
  sendProjectInviteEmail: async (params: any) => {
    emails.push({ kind: 'project', ...params })
    return { success: true }
  },
  sendInviteAcceptedEmail: async () => ({ success: true }),
}))
mock.module('../lib/push-notifications', () => ({
  sendPushToUser: async (userId: string, payload: any) => {
    pushes.push({ userId, ...payload })
  },
}))

const { prisma } = await import('../lib/prisma')
const { invitationHooks } = await import('../generated/invitation.hooks')

const db = prisma as any

const ctx = { body: {}, params: {}, query: {}, userId: 'qa-runner', prisma: db } as any

/** Fresh users + workspace per call: emails and slugs are unique per row. */
async function seed() {
  const suffix = crypto.randomUUID().slice(0, 8)
  const inviter = await db.user.create({
    data: { name: 'Anya', email: `anya-${suffix}@example.com` },
  })
  const invitee = await db.user.create({
    data: { name: 'Sam', email: `sam-${suffix}@example.com` },
  })
  const workspace = await db.workspace.create({
    data: { name: 'Gamma', slug: `gamma-${suffix}`, kind: 'team' },
  })
  return { inviter, invitee, workspace, suffix }
}

async function makeInvitation(args: {
  email: string
  workspaceId: string
  invitedBy: string
  role?: string
}) {
  return db.invitation.create({
    data: {
      email: args.email,
      role: args.role ?? 'member',
      workspaceId: args.workspaceId,
      invitedBy: args.invitedBy,
      status: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
  })
}

function clear() {
  emails.length = 0
  pushes.length = 0
}

afterAll(async () => {
  // The database is a throwaway SQLite file in a temp dir, but the client
  // still holds it open; disconnect so the process can exit cleanly.
  await db.$disconnect?.().catch(() => {})
  void dir
})

describe('SHO-84 AC1 — an existing user gets one bell entry and one push', () => {
  test('the row is real, unread, deep-links to the accept page and names the invitee', async () => {
    clear()
    const { inviter, invitee, workspace } = await seed()
    const invitation = await makeInvitation({
      email: invitee.email,
      workspaceId: workspace.id,
      invitedBy: inviter.id,
      role: 'admin',
    })

    await invitationHooks.afterCreate!(invitation, ctx)

    const rows = await db.notification.findMany({ where: { userId: invitee.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'invitation_pending',
      actionUrl: `/invitations/${invitation.id}/accept`,
      readAt: null,
    })
    expect(rows[0].title).toBe('Anya invited you to Gamma')
    expect(rows[0].message).toContain('Gamma')
    expect(rows[0].metadata).toMatchObject({
      invitationId: invitation.id,
      workspaceId: workspace.id,
      role: 'admin',
    })

    // Nobody else was told (the inviter must not get their own invite).
    expect(await db.notification.count({ where: { userId: inviter.id } })).toBe(0)

    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({
      userId: invitee.id,
      title: 'Anya invited you to Gamma',
      channelId: 'chat-complete',
      data: {
        notificationType: 'invitation_pending',
        invitationId: invitation.id,
        actionUrl: `/invitations/${invitation.id}/accept`,
      },
    })
    expect(emails).toHaveLength(1)
  })

  test('replay of afterCreate for the same invite does not insert a second row', async () => {
    clear()
    const { inviter, invitee, workspace } = await seed()
    const invitation = await makeInvitation({
      email: invitee.email,
      workspaceId: workspace.id,
      invitedBy: inviter.id,
    })

    await invitationHooks.afterCreate!(invitation, ctx)
    await invitationHooks.afterCreate!(invitation, ctx)

    const rows = await db.notification.findMany({ where: { userId: invitee.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actionUrl).toBe(`/invitations/${invitation.id}/accept`)
  })

  test('the emailed link and the notification link are the same path', async () => {
    clear()
    const { inviter, invitee, workspace } = await seed()
    const invitation = await makeInvitation({
      email: invitee.email,
      workspaceId: workspace.id,
      invitedBy: inviter.id,
    })

    await invitationHooks.afterCreate!(invitation, ctx)

    const row = await db.notification.findFirst({ where: { userId: invitee.id } })
    expect(emails).toHaveLength(1)
    expect(emails[0].acceptUrl.endsWith(row.actionUrl)).toBe(true)
  })
})

describe('SHO-84 AC2 — an email with no account is left to the email', () => {
  test('creates no notification and no push, keeps the email, does not throw', async () => {
    clear()
    const { inviter, workspace, suffix } = await seed()
    const invitation = await makeInvitation({
      email: `stranger-${suffix}@example.com`,
      workspaceId: workspace.id,
      invitedBy: inviter.id,
    })

    await invitationHooks.afterCreate!(invitation, ctx)

    expect(pushes).toHaveLength(0)
    expect(emails).toHaveLength(1)
    expect(
      await db.notification.count({
        where: { actionUrl: `/invitations/${invitation.id}/accept` },
      }),
    ).toBe(0)
    const stored = await db.invitation.findUnique({ where: { id: invitation.id } })
    expect(stored.emailStatus).toBe('sent')
  })
})

describe('SHO-84 AC3 — answering the invite clears the bell entry', () => {
  test('accepting marks that row read and leaves another invitation alone', async () => {
    clear()
    const { inviter, invitee, workspace } = await seed()
    const first = await makeInvitation({
      email: invitee.email,
      workspaceId: workspace.id,
      invitedBy: inviter.id,
    })
    const second = await makeInvitation({
      email: invitee.email,
      workspaceId: workspace.id,
      invitedBy: inviter.id,
    })
    await invitationHooks.afterCreate!(first, ctx)
    await invitationHooks.afterCreate!(second, ctx)
    expect(await db.notification.count({ where: { userId: invitee.id } })).toBe(2)

    await invitationHooks.afterUpdate!(
      { id: first.id, status: 'accepted', workspaceId: workspace.id, invitedBy: inviter.id, email: invitee.email },
      ctx,
    )

    const rows = await db.notification.findMany({ where: { userId: invitee.id } })
    const byUrl = Object.fromEntries(rows.map((r: any) => [r.actionUrl, r]))
    expect(byUrl[`/invitations/${first.id}/accept`].readAt).not.toBeNull()
    expect(byUrl[`/invitations/${second.id}/accept`].readAt).toBeNull()
  })

  test('declining marks that row read', async () => {
    clear()
    const { inviter, invitee, workspace } = await seed()
    const invitation = await makeInvitation({
      email: invitee.email,
      workspaceId: workspace.id,
      invitedBy: inviter.id,
    })
    await invitationHooks.afterCreate!(invitation, ctx)

    await invitationHooks.afterUpdate!(
      { id: invitation.id, status: 'declined', workspaceId: workspace.id, invitedBy: inviter.id, email: invitee.email },
      ctx,
    )

    const row = await db.notification.findFirst({ where: { userId: invitee.id } })
    expect(row.readAt).not.toBeNull()
  })

  test('an edit that leaves the invite pending leaves the row unread', async () => {
    clear()
    const { inviter, invitee, workspace } = await seed()
    const invitation = await makeInvitation({
      email: invitee.email,
      workspaceId: workspace.id,
      invitedBy: inviter.id,
    })
    await invitationHooks.afterCreate!(invitation, ctx)

    await invitationHooks.afterUpdate!(
      { id: invitation.id, status: 'pending', workspaceId: workspace.id, invitedBy: inviter.id, email: invitee.email },
      ctx,
    )

    const row = await db.notification.findFirst({ where: { userId: invitee.id } })
    expect(row.readAt).toBeNull()
  })
})

/**
 * SHO-84 AC6 — the link the push carries is a page the app actually serves.
 *
 * The 404 this whole feature area started from was a constant drifting from the
 * route it pointed at. SHO-83 has now mounted `app/invitations/[id]/accept.tsx`,
 * so the three things that have to agree can be tied together here: the shared
 * constant, the notification's `actionUrl`, and the file expo-router turns into
 * the route.
 */
describe('SHO-84 AC6 — the pushed path matches a mounted route', () => {
  const repoRoot = resolve(import.meta.dir, '../../../..')

  test('the constant, the route template and the route file agree', () => {
    const id = 'inv_route_drift'

    expect(INVITATION_ACCEPT_PATH(id)).toBe(`/invitations/${id}/accept`)

    const routeFile = 'apps/mobile/app/invitations/[id]/accept.tsx'
    expect(existsSync(resolve(repoRoot, routeFile))).toBe(true)

    // expo-router: app/<segments>.tsx -> /<segments>, [param] -> :param
    const routePath =
      '/' +
      routeFile
        .replace('apps/mobile/app/', '')
        .replace(/\[(\w+)\]/g, ':$1')
        .replace(/\.tsx$/, '')

    expect(INVITATION_ACCEPT_PATH(':id')).toBe(routePath)
  })
})
