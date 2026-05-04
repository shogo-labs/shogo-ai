// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit test for the daily grant-monthly-refill cron. Mocks the prisma
 * client + billing service so nothing touches the DB. Verifies:
 *
 *  - Workspaces with an active grant and no paid subscription get
 *    refilled once per UTC month.
 *  - Workspaces whose `lastMonthlyReset` is already in the current
 *    period are a no-op (idempotent re-runs).
 *  - Workspaces with a paid subscription are skipped (the Stripe
 *    webhook handles their refill via `allocateMonthlyIncluded`).
 *  - Workspaces without a wallet yet are skipped (the wallet will be
 *    seeded on first usage).
 *
 *   bun test apps/api/src/__tests__/grant-monthly-refill.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

interface GrantRow {
  id: string
  workspaceId: string
  monthlyIncludedUsd: number
  startsAt: Date
  expiresAt: Date | null
  workspace: { subscriptions: Array<{ status: string }> }
}

interface WalletRow {
  workspaceId: string
  lastMonthlyReset: Date
}

let grantRows: GrantRow[] = []
let walletRows: WalletRow[] = []
let applyCalls: Array<{ workspaceId: string; now: Date }> = []

mock.module('../lib/prisma', () => ({
  prisma: {
    workspaceGrant: {
      findMany: async ({ where }: any) => {
        const now: Date = where.startsAt?.lte ?? new Date()
        return grantRows.filter((g) => {
          if (where.monthlyIncludedUsd?.gt != null && g.monthlyIncludedUsd <= where.monthlyIncludedUsd.gt) {
            return false
          }
          if (g.startsAt > now) return false
          if (g.expiresAt && g.expiresAt <= now) return false
          // No active paid subscription.
          const hasActivePaid = g.workspace.subscriptions.some((s) =>
            ['active', 'trialing'].includes(s.status),
          )
          if (where.workspace?.subscriptions?.none && hasActivePaid) return false
          return true
        }).map((g) => ({ workspaceId: g.workspaceId }))
      },
    },
    usageWallet: {
      findUnique: async ({ where }: any) => {
        return walletRows.find((w) => w.workspaceId === where.workspaceId) ?? null
      },
    },
  },
}))

mock.module('../services/billing.service', () => ({
  applyGrantMonthlyAllocation: async (workspaceId: string, now: Date) => {
    applyCalls.push({ workspaceId, now })
    const w = walletRows.find((w) => w.workspaceId === workspaceId)
    if (w) w.lastMonthlyReset = now
    return { workspaceId, monthlyIncludedUsd: 500 }
  },
}))

import { runGrantMonthlyRefill } from '../jobs/grant-monthly-refill'

describe('runGrantMonthlyRefill', () => {
  beforeEach(() => {
    grantRows = []
    walletRows = []
    applyCalls = []
  })

  test('refills workspaces that are eligible (active grant, free tier, stale wallet)', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    const past = new Date('2020-01-01T00:00:00Z')
    grantRows = [
      {
        id: 'g1',
        workspaceId: 'ws_free_a',
        monthlyIncludedUsd: 500,
        startsAt: past,
        expiresAt: null,
        workspace: { subscriptions: [] },
      },
      {
        id: 'g2',
        workspaceId: 'ws_free_b',
        monthlyIncludedUsd: 200,
        startsAt: past,
        expiresAt: null,
        workspace: { subscriptions: [] },
      },
    ]
    // Both wallets are last reset before the start of May 2026.
    walletRows = [
      { workspaceId: 'ws_free_a', lastMonthlyReset: new Date('2026-04-15T00:00:00Z') },
      { workspaceId: 'ws_free_b', lastMonthlyReset: new Date('2026-04-30T23:59:00Z') },
    ]

    const summary = await runGrantMonthlyRefill({ now })

    expect(summary.candidates).toBe(2)
    expect(summary.refilled).toBe(2)
    expect(summary.skipped).toBe(0)
    expect(summary.failed).toBe(0)
    expect(applyCalls.map((c) => c.workspaceId).sort()).toEqual(['ws_free_a', 'ws_free_b'])
  })

  test('re-running inside the same UTC month is a no-op once the wallet is current', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    const past = new Date('2020-01-01T00:00:00Z')
    grantRows = [
      {
        id: 'g1',
        workspaceId: 'ws_free_a',
        monthlyIncludedUsd: 500,
        startsAt: past,
        expiresAt: null,
        workspace: { subscriptions: [] },
      },
    ]
    walletRows = [
      // Already reset at the very start of this UTC month.
      { workspaceId: 'ws_free_a', lastMonthlyReset: new Date('2026-05-01T00:00:00Z') },
    ]

    const summary = await runGrantMonthlyRefill({ now })

    expect(summary.candidates).toBe(1)
    expect(summary.refilled).toBe(0)
    expect(summary.skipped).toBe(1)
    expect(applyCalls).toHaveLength(0)
  })

  test('workspaces without a wallet yet are skipped (lazy-seeded by allocateFreeWallet)', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    const past = new Date('2020-01-01T00:00:00Z')
    grantRows = [
      {
        id: 'g1',
        workspaceId: 'ws_no_wallet',
        monthlyIncludedUsd: 500,
        startsAt: past,
        expiresAt: null,
        workspace: { subscriptions: [] },
      },
    ]
    walletRows = []

    const summary = await runGrantMonthlyRefill({ now })

    expect(summary.candidates).toBe(1)
    expect(summary.refilled).toBe(0)
    expect(summary.skipped).toBe(1)
    expect(applyCalls).toHaveLength(0)
  })

  test('paid workspaces are excluded from the candidate set entirely', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    const past = new Date('2020-01-01T00:00:00Z')
    grantRows = [
      {
        id: 'g1',
        workspaceId: 'ws_paid',
        monthlyIncludedUsd: 500,
        startsAt: past,
        expiresAt: null,
        workspace: { subscriptions: [{ status: 'active' }] },
      },
    ]
    walletRows = [
      { workspaceId: 'ws_paid', lastMonthlyReset: new Date('2026-04-01T00:00:00Z') },
    ]

    const summary = await runGrantMonthlyRefill({ now })

    expect(summary.candidates).toBe(0)
    expect(summary.refilled).toBe(0)
    expect(applyCalls).toHaveLength(0)
  })

  test('expired grants are excluded', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    const past = new Date('2020-01-01T00:00:00Z')
    grantRows = [
      {
        id: 'g_expired',
        workspaceId: 'ws_expired',
        monthlyIncludedUsd: 999,
        startsAt: past,
        expiresAt: new Date('2021-01-01T00:00:00Z'),
        workspace: { subscriptions: [] },
      },
    ]
    walletRows = [
      { workspaceId: 'ws_expired', lastMonthlyReset: new Date('2026-04-01T00:00:00Z') },
    ]

    const summary = await runGrantMonthlyRefill({ now })

    expect(summary.candidates).toBe(0)
    expect(applyCalls).toHaveLength(0)
  })

  test('grants with $0 monthly USD (seat-only) are excluded', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    const past = new Date('2020-01-01T00:00:00Z')
    grantRows = [
      {
        id: 'g_seats_only',
        workspaceId: 'ws_seats',
        monthlyIncludedUsd: 0,
        startsAt: past,
        expiresAt: null,
        workspace: { subscriptions: [] },
      },
    ]
    walletRows = [
      { workspaceId: 'ws_seats', lastMonthlyReset: new Date('2026-04-01T00:00:00Z') },
    ]

    const summary = await runGrantMonthlyRefill({ now })

    expect(summary.candidates).toBe(0)
    expect(applyCalls).toHaveLength(0)
  })
})
