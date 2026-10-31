// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The two "come back" nudges (SHO-258 §4). Push, in-app row and email are
 * faked: what matters here is the gating (away only, once a day, one email
 * per in-app row) and that every channel points at the same link.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const pushes: any[] = []
const notifications: any[] = []
const emails: any[] = []
let notificationExists = false
let userEmail: string | null = 'person@example.com'

mock.module('../prisma', () => ({
  prisma: {
    user: { findUnique: async () => (userEmail ? { email: userEmail } : null) },
  },
}))

mock.module('../push-notifications', () => ({
  sendPushToUser: async (_userId: string, payload: any) => {
    pushes.push(payload)
  },
}))

mock.module('../../services/notification.service', () => ({
  createNotification: async (input: any) => {
    if (notificationExists) return null
    notifications.push(input)
    return { id: 'n-1' }
  },
}))

mock.module('../../services/email.service', () => ({
  sendBuildReadyEmail: async (params: any) => {
    emails.push({ template: 'build-ready', ...params })
    return { success: true }
  },
  sendCreditsResetEmail: async (params: any) => {
    emails.push({ template: 'credits-reset', ...params })
    return { success: true }
  },
}))

const { notifyBuildReady, notifyCreditsReset } = await import('../lifecycle-notifications')

beforeEach(() => {
  pushes.length = 0
  notifications.length = 0
  emails.length = 0
  notificationExists = false
  userEmail = 'person@example.com'
})

describe('notifyBuildReady', () => {
  const base = {
    userId: 'u-1',
    workspaceId: 'ws-1',
    chatSessionId: 's-1',
    projectId: 'p-1',
    projectName: 'Booking page',
    summary: 'Built a booking page with three slots.',
    userAway: true,
  }

  it('sends push + in-app row + one email, all pointing at the project chat', async () => {
    const out = await notifyBuildReady(base)
    expect(out).toEqual({ pushed: true, emailed: true })
    expect(pushes[0].title).toContain('Booking page')
    expect(notifications[0]).toMatchObject({ type: 'build_ready', userId: 'u-1' })
    expect(notifications[0].actionUrl).toContain('/chat?project=p-1')
    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({ template: 'build-ready', to: 'person@example.com' })
    expect(emails[0].projectUrl).toBe(notifications[0].actionUrl)
  })

  it('does nothing when the person is watching the turn', async () => {
    const out = await notifyBuildReady({ ...base, userAway: false })
    expect(out).toEqual({ pushed: false, emailed: false })
    expect(pushes).toHaveLength(0)
    expect(emails).toHaveLength(0)
  })

  it('emails at most once a day: an existing row for the day suppresses the email', async () => {
    notificationExists = true
    const out = await notifyBuildReady(base)
    expect(out.emailed).toBe(false)
    expect(emails).toHaveLength(0)
  })

  it('still pushes when there is no email address on the account', async () => {
    userEmail = null
    const out = await notifyBuildReady(base)
    expect(out.pushed).toBe(true)
    expect(out.emailed).toBe(false)
  })
})

describe('notifyCreditsReset', () => {
  it('names the reset time and links to the last project', async () => {
    const resetAt = new Date('2026-10-30T19:00:00.000Z')
    await notifyCreditsReset({
      userId: 'u-2',
      workspaceId: 'ws-2',
      projectId: 'p-2',
      projectName: 'Invoice generator',
      resetAt,
    })
    expect(pushes[0].title).toBe('Your agent is back')
    expect(notifications[0].type).toBe('credits_reset')
    expect(notifications[0].actionUrl).toContain('/chat?project=p-2')
    expect(emails[0]).toMatchObject({ template: 'credits-reset', continueUrl: notifications[0].actionUrl })
    // The dedupe key is per cap, so a second cap the same day still notifies.
    expect(notifications[0].dedupeKey).toBe(`credits_reset:ws-2:${resetAt.toISOString()}`)
  })

  it('carries projectId in metadata so the phone can offer "Continue <project>"', async () => {
    const resetAt = new Date('2026-10-30T19:00:00.000Z')
    await notifyCreditsReset({
      userId: 'u-2',
      workspaceId: 'ws-2',
      projectId: 'p-2',
      projectName: 'Invoice generator',
      resetAt,
    })
    expect(notifications[0].metadata).toMatchObject({ projectId: 'p-2', workspaceId: 'ws-2' })
  })

  it('writes projectId: null when the workspace has no project', async () => {
    await notifyCreditsReset({
      userId: 'u-3',
      workspaceId: 'ws-3',
      projectId: null,
      projectName: 'your workspace',
      resetAt: new Date('2026-10-30T19:00:00.000Z'),
    })
    expect(notifications[0].metadata).toMatchObject({ projectId: null, workspaceId: 'ws-3' })
    expect(notifications[0].actionUrl).not.toContain('?project=')
  })
})
