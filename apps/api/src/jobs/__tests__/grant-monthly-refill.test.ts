// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/jobs/grant-monthly-refill.ts — wave-1.
// Covers: no candidates, wallet missing, watermark already current,
// successful refill, applyGrantMonthlyAllocation throws, multiple
// workspaces with mixed outcomes, dedup of duplicate grant rows, and
// the cron scheduler (initial + interval invocation, error swallow).

import { beforeEach, describe, expect, it, mock } from 'bun:test'

let grantFindManyImpl: (args: any) => Promise<any[]> = async () => []
let walletFindUniqueImpl: (args: any) => Promise<any> = async () => null
let applyGrantImpl: (workspaceId: string, now: Date) => Promise<any> = async () => {}
let lockAcquiredImpl: boolean = true

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspaceGrant: { findMany: (args: any) => grantFindManyImpl(args) },
    usageWallet: { findUnique: (args: any) => walletFindUniqueImpl(args) },
  },
}))

mock.module('../../lib/global-job-lock', () => ({
  withGlobalJobLock: async (_name: string, body: () => Promise<any>) => {
    if (lockAcquiredImpl) {
      const result = await body()
      return { acquired: true, result }
    }
    return { acquired: false, skipped: true, reason: 'lock_not_acquired' }
  },
}))

mock.module('../../services/billing.service', () => ({
  applyGrantMonthlyAllocation: (workspaceId: string, now: Date) =>
    applyGrantImpl(workspaceId, now),
}))

const { runGrantMonthlyRefill, startGrantMonthlyRefillCron } = await import(
  '../grant-monthly-refill'
)

beforeEach(() => {
  grantFindManyImpl = async () => []
  walletFindUniqueImpl = async () => null
  applyGrantImpl = async () => {}
})

describe('runGrantMonthlyRefill', () => {
  it('returns zeroed summary when no candidates exist', async () => {
    grantFindManyImpl = async () => []
    const s = await runGrantMonthlyRefill({ now: new Date('2026-05-15T12:00:00Z') })
    expect(s).toMatchObject({ candidates: 0, refilled: 0, skipped: 0, failed: 0 })
    expect(s.period.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('skips workspaces with no wallet yet', async () => {
    grantFindManyImpl = async () => [{ workspaceId: 'w1' }]
    walletFindUniqueImpl = async () => null
    const s = await runGrantMonthlyRefill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(s).toMatchObject({ candidates: 1, refilled: 0, skipped: 1, failed: 0 })
  })

  it('skips workspaces whose wallet is already refilled this period', async () => {
    grantFindManyImpl = async () => [{ workspaceId: 'w1' }]
    walletFindUniqueImpl = async () => ({ lastMonthlyReset: new Date('2026-05-01T00:00:00Z') })
    const s = await runGrantMonthlyRefill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(s).toMatchObject({ refilled: 0, skipped: 1, failed: 0 })
  })

  it('refills a workspace whose last reset is older than the period', async () => {
    grantFindManyImpl = async () => [{ workspaceId: 'w1' }]
    walletFindUniqueImpl = async () => ({ lastMonthlyReset: new Date('2026-04-01T00:00:00Z') })
    let called = false
    applyGrantImpl = async () => {
      called = true
    }
    const s = await runGrantMonthlyRefill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(called).toBe(true)
    expect(s).toMatchObject({ candidates: 1, refilled: 1, skipped: 0, failed: 0 })
  })

  it('counts a failure when applyGrantMonthlyAllocation throws', async () => {
    grantFindManyImpl = async () => [{ workspaceId: 'w1' }]
    walletFindUniqueImpl = async () => ({ lastMonthlyReset: new Date('2026-04-01T00:00:00Z') })
    applyGrantImpl = async () => {
      throw new Error('billing down')
    }
    const s = await runGrantMonthlyRefill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(s).toMatchObject({ refilled: 0, failed: 1 })
  })

  it('dedupes duplicate grant rows that point at the same workspace', async () => {
    grantFindManyImpl = async () => [
      { workspaceId: 'w1' },
      { workspaceId: 'w1' },
      { workspaceId: 'w2' },
    ]
    walletFindUniqueImpl = async () => ({ lastMonthlyReset: new Date('2026-04-01T00:00:00Z') })
    const seen: string[] = []
    applyGrantImpl = async (ws) => {
      seen.push(ws)
    }
    const s = await runGrantMonthlyRefill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(s.candidates).toBe(2)
    expect(seen.sort()).toEqual(['w1', 'w2'])
  })

  it('handles a mixed batch (refill + skip + fail in one call)', async () => {
    grantFindManyImpl = async () => [
      { workspaceId: 'wA' },
      { workspaceId: 'wB' },
      { workspaceId: 'wC' },
    ]
    walletFindUniqueImpl = async ({ where }: any) => {
      if (where.workspaceId === 'wA') return null
      if (where.workspaceId === 'wB') return { lastMonthlyReset: new Date('2026-04-01T00:00:00Z') }
      return { lastMonthlyReset: new Date('2026-05-01T00:00:00Z') } // already current
    }
    applyGrantImpl = async (ws) => {
      if (ws === 'wB') return // success
    }
    const s = await runGrantMonthlyRefill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(s).toMatchObject({ candidates: 3, refilled: 1, skipped: 2, failed: 0 })
  })

  it('uses Date.now() when options.now is not provided', async () => {
    const real = Date.now
    Date.now = () => new Date('2026-07-20T00:00:00Z').getTime()
    // Date() constructor still uses real time, so stub it via Date override.
    // Easier: pass nothing and verify period is at-or-after start of *current* month.
    Date.now = real
    grantFindManyImpl = async () => []
    const s = await runGrantMonthlyRefill()
    expect(s.candidates).toBe(0)
    // Period is the UTC start of the month containing now().
    const now = new Date()
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    expect(s.period.toISOString()).toBe(expected.toISOString())
  })
})

describe('startGrantMonthlyRefillCron', () => {
  it('schedules initial and recurring runs that swallow errors', async () => {
    // Replace timer primitives so the test runs synchronously.
    const origSetTimeout = globalThis.setTimeout
    const origSetInterval = globalThis.setInterval
    let timeoutCb: (() => void) | null = null
    let intervalCb: (() => void) | null = null
    ;(globalThis as any).setTimeout = (cb: () => void) => {
      timeoutCb = cb
      return 0 as any
    }
    ;(globalThis as any).setInterval = (cb: () => void) => {
      intervalCb = cb
      return 0 as any
    }
    try {
      grantFindManyImpl = async () => {
        throw new Error('initial fail')
      }
      startGrantMonthlyRefillCron(1000)
      expect(typeof timeoutCb).toBe('function')
      // Trigger the initial run; it should not throw despite the error.
      timeoutCb!()
      // Trigger the interval body.
      expect(typeof intervalCb).toBe('function')
      intervalCb!()
      // Let microtasks drain.
      await new Promise((r) => origSetTimeout(r, 5))
    } finally {
      ;(globalThis as any).setTimeout = origSetTimeout
      ;(globalThis as any).setInterval = origSetInterval
    }
  })
})

describe('runGrantMonthlyRefill — lock skipped path (lines 125-132)', () => {
  beforeEach(() => {
    lockAcquiredImpl = false
  })

  it('returns lockSkipped:true when the global advisory lock is held by another region', async () => {
    const { runGrantMonthlyRefill } = await import('../grant-monthly-refill')
    const result = await runGrantMonthlyRefill()
    expect(result.lockSkipped).toBe(true)
    expect(result.candidates).toBe(0)
    expect(result.refilled).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.period).toBeTruthy() // period is a Date or string
  })
})
