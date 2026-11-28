// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every 402 in the API builds its payload through `buildUsageLimitInfo`, so
 * that is the single place a cap gets recorded (SHO-258 §2): `firstCapHitAt`
 * set once, the wallet's `capNotifyPendingAt` flag for the reset job, and one
 * `hit_cap` event. The prisma and Loops layers are faked here — the point is
 * the contract, not the transport.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface UpdateCall { model: 'user' | 'usageWallet'; args: any }
const updates: UpdateCall[] = []
const events: Array<{ userId: string; name: string; props: any }> = []
let windowsImpl: () => Promise<any>
/** What `prisma.user.findUnique` answers with — the first-session rule reads it. */
let userCreatedAt: Date | null = null

mock.module('../../services/billing-runtime', () => ({
  getUsageWindows: () => windowsImpl(),
}))

mock.module('../prisma', () => ({
  prisma: {
    user: {
      findUnique: async () => (userCreatedAt ? { createdAt: userCreatedAt } : null),
      updateMany: (args: any) => {
        updates.push({ model: 'user', args })
        return Promise.resolve({ count: 1 })
      },
    },
    usageWallet: {
      updateMany: (args: any) => {
        updates.push({ model: 'usageWallet', args })
        return Promise.resolve({ count: 1 })
      },
    },
  },
}))

mock.module('../../services/loops.service', () => ({
  trackEvent: (userId: string, name: string, props: any) => {
    events.push({ userId, name, props })
    return Promise.resolve()
  },
}))

const { buildUsageLimitInfo } = await import('../usage-limit-info')
const { reportUsageLimitHit, recordFirstPreviewSeen } = await import('../usage-cap-events')

function exhaustedWeek() {
  const resetsAt = new Date(Date.now() + 60 * 60 * 1000)
  return {
    fiveHour: { kind: 'five_hour', limitUsd: 5, utilization: 0.4, resetsAt },
    weekly: { kind: 'weekly', limitUsd: 50, utilization: 1, resetsAt },
  }
}

beforeEach(() => {
  updates.length = 0
  events.length = 0
  windowsImpl = async () => exhaustedWeek()
  userCreatedAt = null
})

describe('usage cap recording', () => {
  it('sets firstCapHitAt once and flags the wallet with the gating window', async () => {
    const info = await buildUsageLimitInfo('ws-1', { userId: 'u-1', source: 'workspace-chat' })
    expect(info.window).toBe('weekly')
    expect(info.resetsAt).not.toBeNull()

    const userUpdate = updates.find((u) => u.model === 'user')
    expect(userUpdate?.args.where).toEqual({ id: 'u-1', firstCapHitAt: null })
    expect(userUpdate?.args.data.firstCapHitAt).toBeInstanceOf(Date)

    const walletUpdate = updates.find((u) => u.model === 'usageWallet')
    expect(walletUpdate?.args.where).toEqual({ workspaceId: 'ws-1', capNotifyPendingAt: null })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      userId: 'u-1',
      name: 'hit_cap',
      props: { workspace_id: 'ws-1', window: 'weekly', source: 'workspace-chat' },
    })
  })

  it('records the cap without a user when the turn is billed as system', async () => {
    await reportUsageLimitHit({ workspaceId: 'ws-2', userId: 'system', window: 'five_hour' })
    expect(updates.some((u) => u.model === 'user')).toBe(false)
    // The wallet flag still goes down: the reset job keys off the workspace.
    expect(updates.find((u) => u.model === 'usageWallet')?.args.where).toEqual({
      workspaceId: 'ws-2',
      capNotifyPendingAt: null,
    })
    expect(events).toHaveLength(0)
  })

  it('a 402 still answers when the windows cannot be resolved', async () => {
    windowsImpl = () => Promise.reject(new Error('billing down'))
    const info = await buildUsageLimitInfo('ws-3', { userId: 'u-3' })
    expect(info).toEqual({ resetsAt: null, window: null, retryAfterSeconds: null })
    expect(events[0]?.props.window).toBeNull()
  })

  // SHO-614 (G8): a first build can hit the cap before it finishes, and that
  // visitor is not the same as a long-standing user on a weekly limit.
  it('marks hit_cap first_session for an account younger than 24 hours', async () => {
    userCreatedAt = new Date(Date.now() - 60 * 60 * 1000)
    await reportUsageLimitHit({ workspaceId: 'ws-1', userId: 'u-1', window: 'five_hour' })
    expect(events[0]?.props.first_session).toBe(true)
  })

  it('marks hit_cap first_session false for an older account', async () => {
    userCreatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await reportUsageLimitHit({ workspaceId: 'ws-1', userId: 'u-1', window: 'weekly' })
    expect(events[0]?.props.first_session).toBe(false)
  })

  it('keeps the 402 answer when createdAt cannot be read', async () => {
    userCreatedAt = null
    const info = await buildUsageLimitInfo('ws-1', { userId: 'u-1' })
    expect(info.window).toBe('weekly')
    expect(events[0]?.props.first_session).toBe(false)
  })
})

describe('firstPreviewSeenAt', () => {
  it('is written once, guarded on null', async () => {
    await recordFirstPreviewSeen('u-4')
    const update = updates.find((u) => u.model === 'user')
    expect(update?.args.where).toEqual({ id: 'u-4', firstPreviewSeenAt: null })
    expect(update?.args.data.firstPreviewSeenAt).toBeInstanceOf(Date)
  })

  it('ignores an anonymous viewer', async () => {
    await recordFirstPreviewSeen(null)
    await recordFirstPreviewSeen('system')
    expect(updates).toHaveLength(0)
  })
})
