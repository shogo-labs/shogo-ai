// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for the invitation hooks' invitee notification: an existing user
// gets one in-app `invitation_pending` row (deep-linking to the accept page)
// plus one push, an unknown email gets neither, a notification failure never
// blocks the email, and answering the invite clears the row.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Capture the real modules first so we can restore them in afterAll: bun's
// mock.module is process-global and would otherwise leak into other test
// files (e.g. the email / notification service suites) run in the same process.
const realNotificationService = { ...(await import('../services/notification.service')) }
const realEmailService = { ...(await import('../services/email.service')) }
const realPush = { ...(await import('../lib/push-notifications')) }

const notifications: any[] = []
const emails: any[] = []
const pushes: any[] = []
let notificationShouldThrow = false

mock.module('../services/notification.service', () => ({
  createNotification: async (input: any) => {
    if (notificationShouldThrow) throw new Error('boom')
    notifications.push(input)
    return { id: `n-${notifications.length}` }
  },
}))
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

const { invitationHooks } = await import('../generated/invitation.hooks')

const INVITATION = {
  id: 'inv-1',
  email: 'invitee@example.com',
  workspaceId: 'ws-1',
  projectId: null,
  invitedBy: 'user-admin',
  role: 'member',
}

function makeCtx(existingUser: { id: string } | null) {
  const updates: any[] = []
  const readMarks: any[] = []
  const prisma = {
    workspace: { findUnique: async () => ({ name: 'Acme' }) },
    project: { findUnique: async () => null },
    user: {
      findUnique: async () => ({ name: 'Anya', email: 'anya@example.com' }),
      findFirst: async () => existingUser,
    },
    invitation: { update: async (args: any) => void updates.push(args) },
    notification: { updateMany: async (args: any) => void readMarks.push(args) },
  }
  return {
    ctx: { body: {}, params: {}, query: {}, userId: 'user-admin', prisma } as any,
    updates,
    readMarks,
  }
}

afterAll(() => {
  mock.module('../services/notification.service', () => realNotificationService)
  mock.module('../services/email.service', () => realEmailService)
  mock.module('../lib/push-notifications', () => realPush)
})

beforeEach(() => {
  notifications.length = 0
  emails.length = 0
  pushes.length = 0
  notificationShouldThrow = false
})

describe('invitationHooks.afterCreate invitee notification', () => {
  test('creates invitation_pending notification and one push for an existing user', async () => {
    const { ctx } = makeCtx({ id: 'user-invitee' })
    await invitationHooks.afterCreate!(INVITATION, ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      userId: 'user-invitee',
      type: 'invitation_pending',
      actionUrl: '/invitations/inv-1/accept',
      dedupeKey: 'inv-1',
      metadata: { invitationId: 'inv-1', workspaceId: 'ws-1', projectId: null, role: 'member' },
    })
    expect(notifications[0].title).toBe('Anya invited you to Acme')

    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({
      userId: 'user-invitee',
      type: 'invitation',
      channelId: 'chat-complete',
      data: { notificationType: 'invitation_pending', invitationId: 'inv-1', actionUrl: '/invitations/inv-1/accept' },
    })
    expect(emails).toHaveLength(1)
  })

  test('the emailed accept link and the notification link are the same path', async () => {
    const { ctx } = makeCtx({ id: 'user-invitee' })
    await invitationHooks.afterCreate!(INVITATION, ctx)

    expect(emails[0].acceptUrl.endsWith('/invitations/inv-1/accept')).toBe(true)
    expect(notifications[0].actionUrl).toBe('/invitations/inv-1/accept')
  })

  test('skips notification and push when no account exists for the email', async () => {
    const { ctx } = makeCtx(null)
    await invitationHooks.afterCreate!(INVITATION, ctx)

    expect(notifications).toHaveLength(0)
    expect(pushes).toHaveLength(0)
    expect(emails).toHaveLength(1)
  })

  test('still sends the email and records status if the notification fails', async () => {
    notificationShouldThrow = true
    const { ctx, updates } = makeCtx({ id: 'user-invitee' })
    await invitationHooks.afterCreate!(INVITATION, ctx)

    expect(notifications).toHaveLength(0)
    expect(emails).toHaveLength(1)
    expect(updates[0].data.emailStatus).toBe('sent')
  })
})

describe('invitationHooks.afterUpdate clears the bell entry', () => {
  test('accepting marks the invitation notification read', async () => {
    const { ctx, readMarks } = makeCtx({ id: 'user-invitee' })
    await invitationHooks.afterUpdate!(
      { id: 'inv-1', status: 'accepted', projectId: null, invitedBy: 'user-admin', email: INVITATION.email },
      ctx,
    )

    expect(readMarks).toHaveLength(1)
    expect(readMarks[0].where).toEqual({ type: 'invitation_pending', actionUrl: '/invitations/inv-1/accept' })
    expect(readMarks[0].data.readAt).toBeInstanceOf(Date)
  })

  test('declining marks the invitation notification read', async () => {
    const { ctx, readMarks } = makeCtx({ id: 'user-invitee' })
    await invitationHooks.afterUpdate!({ id: 'inv-1', status: 'declined' }, ctx)

    expect(readMarks).toHaveLength(1)
    expect(readMarks[0].where.actionUrl).toBe('/invitations/inv-1/accept')
  })

  test('an unrelated status change leaves notifications alone', async () => {
    const { ctx, readMarks } = makeCtx({ id: 'user-invitee' })
    await invitationHooks.afterUpdate!({ id: 'inv-1', status: 'pending' }, ctx)

    expect(readMarks).toHaveLength(0)
  })
})
