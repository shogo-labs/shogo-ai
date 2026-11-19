// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/jobs/storage-usage-bill.ts (SHO-423).
// Covers: GB-month proration per completed day, one charge per workspace per
// day, a rerun charging nothing (the `billedAt` claim), an out-of-funds debit
// rolling the claim back, shadow mode recording without debiting, local mode
// doing nothing, and the home-region partition.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let pendingRows: any[] = []
let claimOk = true
let consumeImpl: (args: any) => Promise<any> = async () => ({ success: true })
/** Rows the conditional claim update matched (0 simulates a peer pod winning). */
let claimCount = 1

const findManyCalls: any[] = []
const updateManyCalls: any[] = []
const consumeCalls: any[] = []
const claimPeriodCalls: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    storageUsageDaily: {
      findMany: (args: any) => {
        findManyCalls.push(args)
        return Promise.resolve(pendingRows)
      },
      updateMany: (args: any) => {
        updateManyCalls.push(args)
        // The claim sets `billedAt`; the rollback clears it again.
        const isClaim = args.data?.billedAt != null
        return Promise.resolve({ count: isClaim ? claimCount : 1 })
      },
    },
  },
}))

mock.module('../../lib/region-period-claim', () => ({
  claimRegionPeriod: async (name: string, periodMs: number, now?: Date) => {
    claimPeriodCalls.push({ name, periodMs, now })
    return claimOk
  },
}))

const regionState: { home: any } = { home: null }
mock.module('../../lib/region', () => ({
  homeRegionWorkspaceWhere: () => regionState.home,
}))

mock.module('../../services/billing.service', () => ({
  consumeUsage: (args: any) => {
    consumeCalls.push(args)
    return consumeImpl(args)
  },
}))

const { runStorageUsageBill } = await import('../storage-usage-bill')
const { INSTANCE_SIZES } = await import('../../config/instance-sizes')
const { STORAGE_USD_PER_GB_MONTH } = await import('../../config/storage-pricing')

const SMALL = INSTANCE_SIZES.small.storageLimitBytes

/** One completed day for a workspace, `overBytes` above the small allowance. */
function dayRow(overrides: Partial<any> = {}) {
  const over = 31 * 1024 ** 3 // 31 GB over in a 31-day month → 1 GB-month
  return {
    id: 'row-1',
    workspaceId: 'ws-1',
    // 2026-01-15: January has 31 days.
    day: new Date('2026-01-15T00:00:00Z'),
    billableBytes: BigInt(SMALL + over),
    allowanceBytes: BigInt(SMALL),
    ...overrides,
  }
}

beforeEach(() => {
  pendingRows = []
  claimOk = true
  claimCount = 1
  consumeImpl = async () => ({ success: true })
  findManyCalls.length = 0
  updateManyCalls.length = 0
  consumeCalls.length = 0
  claimPeriodCalls.length = 0
  regionState.home = null
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.STORAGE_BILLING_MODE
})

// Leave the process env as we found it: bun shares one process across test
// files, and a leaked `enforce` flips other suites' shadow-mode assertions.
afterEach(() => {
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.STORAGE_BILLING_MODE
})

describe('runStorageUsageBill', () => {
  it('charges the prorated GB-months of one completed day', async () => {
    process.env.STORAGE_BILLING_MODE = 'enforce'
    pendingRows = [dayRow()]

    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    expect(summary.days).toBe(1)
    expect(summary.billed).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.totalUsd).toBeCloseTo(STORAGE_USD_PER_GB_MONTH, 6)
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('storage')
    expect(consumeCalls[0].workspaceId).toBe('ws-1')
    expect(consumeCalls[0].billedUsd).toBeCloseTo(STORAGE_USD_PER_GB_MONTH, 6)
    expect(consumeCalls[0].actionMetadata.day).toBe('2026-01-15')
    // 31 GB over the allowance, reported in the event for support.
    expect(consumeCalls[0].actionMetadata.overageBytes).toBe(31 * 1024 ** 3)
  })

  it('claims the day before debiting so a rerun cannot double-charge', async () => {
    process.env.STORAGE_BILLING_MODE = 'enforce'
    pendingRows = [dayRow()]

    await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    const claim = updateManyCalls[0]
    expect(claim.where).toEqual({ id: 'row-1', billedAt: null })
    expect(claim.data.billedAt).toBeInstanceOf(Date)
    expect(consumeCalls).toHaveLength(1)
  })

  it('skips a day a peer pod already claimed', async () => {
    pendingRows = [dayRow()]
    claimCount = 0

    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    expect(summary.skipped).toBe(1)
    expect(summary.billed).toBe(0)
    expect(consumeCalls).toHaveLength(0)
  })

  it('rolls the claim back when the debit is refused, so the next tick retries', async () => {
    process.env.STORAGE_BILLING_MODE = 'enforce'
    pendingRows = [dayRow()]
    consumeImpl = async () => ({ success: false, reason: 'insufficient_funds' })

    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    expect(summary.failed).toBe(1)
    expect(summary.billed).toBe(0)
    const rollback = updateManyCalls[updateManyCalls.length - 1]
    expect(rollback.data).toEqual({ billedAt: null, chargedUsd: null })
  })

  it('records but never debits in shadow mode', async () => {
    pendingRows = [dayRow()]

    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    expect(summary.mode).toBe('shadow')
    expect(summary.shadowed).toBe(1)
    expect(summary.billed).toBe(0)
    expect(summary.totalUsd).toBeCloseTo(STORAGE_USD_PER_GB_MONTH, 6)
    expect(consumeCalls).toHaveLength(0)
    // The day is still closed, so flipping to enforce later does not bill the
    // whole shadow window retroactively.
    expect(updateManyCalls[0].data.billedAt).toBeInstanceOf(Date)
  })

  it('debits in enforce mode', async () => {
    process.env.STORAGE_BILLING_MODE = 'enforce'
    pendingRows = [dayRow()]

    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    expect(summary.mode).toBe('enforce')
    expect(summary.billed).toBe(1)
    expect(summary.shadowed).toBe(0)
    expect(consumeCalls).toHaveLength(1)
  })

  it('charges nothing for a day at or under the allowance', async () => {
    process.env.STORAGE_BILLING_MODE = 'enforce'
    pendingRows = [
      dayRow({ billableBytes: BigInt(SMALL), allowanceBytes: BigInt(SMALL) }),
    ]

    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    expect(summary.billed).toBe(0)
    expect(summary.skipped).toBe(1)
    expect(consumeCalls).toHaveLength(0)
    // The day is still closed — it was measured, it just owed nothing.
    expect(updateManyCalls[0].data.billedAt).toBeInstanceOf(Date)
  })

  it('only reads days that are already complete, home-region scoped', async () => {
    regionState.home = { homeRegion: 'eu-frankfurt-1' }
    await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    const args = findManyCalls[0]
    expect(args.where.billedAt).toBeNull()
    // Today (2026-01-16) is still accruing, so the filter stops before it.
    expect(args.where.day.lt.toISOString()).toBe('2026-01-16T00:00:00.000Z')
    expect(args.where.workspace).toEqual({ homeRegion: 'eu-frankfurt-1' })
  })

  it('does nothing when another pod in this region already billed today', async () => {
    claimOk = false
    pendingRows = [dayRow()]

    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    expect(summary.claimed).toBe(false)
    expect(findManyCalls).toHaveLength(0)
    expect(consumeCalls).toHaveLength(0)
  })

  it('claims the region period once per day', async () => {
    await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))
    expect(claimPeriodCalls).toHaveLength(1)
    expect(claimPeriodCalls[0].name).toBe('storage-usage-bill')
    expect(claimPeriodCalls[0].periodMs).toBe(24 * 60 * 60 * 1000)
  })

  it('does nothing in local mode', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    pendingRows = [dayRow()]

    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    expect(summary.days).toBe(0)
    expect(summary.claimed).toBe(false)
    expect(findManyCalls).toHaveLength(0)
    expect(claimPeriodCalls).toHaveLength(0)
  })

  it('reports an empty backlog without debiting', async () => {
    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))
    expect(summary.claimed).toBe(true)
    expect(summary.days).toBe(0)
    expect(summary.totalUsd).toBe(0)
    expect(consumeCalls).toHaveLength(0)
  })

  it('isolates a failing row and keeps billing the rest', async () => {
    pendingRows = [
      dayRow({ id: 'row-bad', workspaceId: 'ws-bad' }),
      dayRow({ id: 'row-ok', workspaceId: 'ws-ok' }),
    ]
    process.env.STORAGE_BILLING_MODE = 'enforce'
    consumeImpl = async (args: any) => {
      if (args.workspaceId === 'ws-bad') throw new Error('wallet exploded')
      return { success: true }
    }

    const summary = await runStorageUsageBill(new Date('2026-01-16T06:00:00Z'))

    expect(summary.failed).toBe(1)
    expect(summary.billed).toBe(1)
  })
})
