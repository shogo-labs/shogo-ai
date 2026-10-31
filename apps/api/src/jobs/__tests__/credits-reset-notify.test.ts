// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The credits-reset sweep (SHO-258 §4): notify once, when the 5-hour window the
 * cap happened in has actually reopened, and clear the flag only for what it
 * saw — a fresh cap that lands mid-send must survive.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const NOW = new Date('2026-10-30T20:00:00.000Z')
const HOUR = 60 * 60 * 1000

let wallets: any[] = []
let sent: any[] = []
let cleared: any[] = []
let member: { userId: string } | null = { userId: 'u-1' }
let lastSession: { contextId: string | null } | null = { contextId: 'p-1' }

mock.module('../../lib/prisma', () => ({
  prisma: {
    usageWallet: {
      findMany: async () => wallets,
      updateMany: async (args: any) => {
        cleared.push(args.where)
        return { count: 1 }
      },
    },
    member: { findFirst: async () => member },
    chatSession: { findFirst: async () => lastSession },
    project: { findUnique: async () => ({ name: 'Booking page' }) },
  },
}))

mock.module('../../lib/region', () => ({
  // null = single region: every wallet is ours.
  homeWorkspaceIds: async () => null,
}))

mock.module('../../lib/lifecycle-notifications', () => ({
  notifyCreditsReset: async (input: any) => {
    sent.push(input)
  },
}))

const { runCreditsResetNotify } = await import('../credits-reset-notify')

beforeEach(() => {
  sent = []
  cleared = []
  member = { userId: 'u-1' }
  lastSession = { contextId: 'p-1' }
})

function wallet(startedHoursAgo: number) {
  return {
    workspaceId: 'ws-1',
    capNotifyPendingAt: new Date(NOW.getTime() - 4 * HOUR),
    fiveHourWindowStart: new Date(NOW.getTime() - startedHoursAgo * HOUR),
  }
}

describe('runCreditsResetNotify', () => {
  it('notifies once the 5-hour window has reopened and clears the flag', async () => {
    wallets = [wallet(6)]
    const summary = await runCreditsResetNotify({ now: NOW })
    expect(summary).toMatchObject({ pending: 1, notified: 1, failed: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ userId: 'u-1', workspaceId: 'ws-1', projectId: 'p-1', projectName: 'Booking page' })
    expect(cleared[0]).toEqual({
      workspaceId: 'ws-1',
      capNotifyPendingAt: new Date(NOW.getTime() - 4 * HOUR),
    })
  })

  it('leaves the flag alone while the same window is still running', async () => {
    wallets = [wallet(2)]
    const summary = await runCreditsResetNotify({ now: NOW })
    expect(summary.notified).toBe(0)
    expect(sent).toHaveLength(0)
    expect(cleared).toHaveLength(0)
  })

  it('drops the flag when there is nobody to tell, rather than retrying forever', async () => {
    member = null
    wallets = [wallet(6)]
    const summary = await runCreditsResetNotify({ now: NOW })
    expect(summary.notified).toBe(0)
    expect(sent).toHaveLength(0)
    expect(cleared).toHaveLength(1)
  })

  it('names the workspace when the person never opened a project chat', async () => {
    lastSession = null
    wallets = [wallet(6)]
    await runCreditsResetNotify({ now: NOW })
    expect(sent[0]).toMatchObject({ projectId: null, projectName: 'your workspace' })
  })
})
