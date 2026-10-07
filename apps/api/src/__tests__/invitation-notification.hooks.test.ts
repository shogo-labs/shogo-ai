// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for invitation afterCreate: an existing user gets an in-app
// `invitation_pending` notification that deep-links to the accept route, an
// unknown email does not, and a notification failure never blocks the email.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Capture the real modules first so we can restore them in afterAll: bun's
// mock.module is process-global and would otherwise leak into other test
// files (e.g. the email / notification service suites) run in the same process.
const realNotificationService = { ...(await import('../services/notification.service')) }
const realEmailService = { ...(await import('../services/email.service')) }

const notifications: any[] = []
const emails: any[] = []
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
  const prisma = {
    workspace: { findUnique: async () => ({ name: 'Acme' }) },
    project: { findUnique: async () => null },
    user: {
      findUnique: async () => ({ name: 'Anya', email: 'anya@example.com' }),
      findFirst: async () => existingUser,
    },
    invitation: { update: async (args: any) => void updates.push(args) },
  }
  return { ctx: { body: {}, params: {}, query: {}, userId: 'user-admin', prisma } as any, updates }
}

afterAll(() => {
  mock.module('../services/notification.service', () => realNotificationService)
  mock.module('../services/email.service', () => realEmailService)
})

beforeEach(() => {
  notifications.length = 0
  emails.length = 0
  notificationShouldThrow = false
})

describe('invitationHooks.afterCreate notification', () => {
  test('creates invitation_pending notification for an existing user', async () => {
    const { ctx } = makeCtx({ id: 'user-invitee' })
    await invitationHooks.afterCreate!(INVITATION, ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      userId: 'user-invitee',
      type: 'invitation_pending',
      actionUrl: '/invitations/inv-1/accept',
      dedupeKey: 'inv-1',
    })
    expect(notifications[0].title).toBe('Anya invited you to Acme')
    expect(emails).toHaveLength(1)
  })

  test('skips the notification when no account exists for the email', async () => {
    const { ctx } = makeCtx(null)
    await invitationHooks.afterCreate!(INVITATION, ctx)

    expect(notifications).toHaveLength(0)
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
