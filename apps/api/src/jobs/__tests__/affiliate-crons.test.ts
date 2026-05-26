// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the three affiliate cron entry points.
 *
 * IMPORTANT: bun's `mock.module` is process-global. To avoid poisoning
 * the standalone affiliate.service tests we DO NOT mock the affiliate
 * service module — instead we mock `withGlobalJobLock` + prisma + the
 * underlying lookup table so the real service runs through but doesn't
 * touch real data. The cron files themselves are paper-thin: we mainly
 * verify the lock contract and the flag short-circuit.
 *
 * (Service-level behavior is exhaustively covered by
 *  apps/api/src/services/__tests__/affiliate.service.test.ts.)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

let lockAcquired = true
const acquireLog: string[] = []
mock.module('../../lib/global-job-lock', () => ({
  withGlobalJobLock: async (jobName: string, body: () => any) => {
    acquireLog.push(jobName)
    if (!lockAcquired) return { acquired: false, skipped: true, reason: 'lock_not_acquired' }
    return { acquired: true, result: await body() }
  },
  KNOWN_JOB_IDS: {},
  jobNameToLockId: () => 0n,
}))

// Minimal prisma so the real service can run a benign tick. Returns
// "no work" everywhere — none of the cron entry-point tests need to
// verify the deep service behavior, just the wiring.
const prismaStub = {
  affiliateCommission: {
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
    update: async () => ({}),
    create: async () => ({}),
    groupBy: async () => [],
    count: async () => 0,
  },
  affiliate: {
    findMany: async () => [],
    findUnique: async () => null,
    update: async () => ({}),
  },
  affiliateCommissionTier: { findMany: async () => [] },
  affiliateAttribution: { findUnique: async () => null },
  affiliatePayout: {
    create: async ({ data }: any) => ({ id: `p_${Date.now()}`, ...data }),
    update: async () => ({}),
    findMany: async () => [],
  },
}
mock.module('../../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))

const approveJob = await import('../approve-eligible-commissions')
const payoutJob = await import('../run-affiliate-payouts')
const reconJob = await import('../affiliate-invoice-reconciliation')

beforeEach(() => {
  lockAcquired = true
  acquireLog.length = 0
})

afterEach(() => {
  delete process.env.SHOGO_AFFILIATES_NATIVE
})

describe('runApproveEligibleCommissions', () => {
  test('returns flagDisabled when flag is off', async () => {
    const res = await approveJob.runApproveEligibleCommissions()
    expect(res.flagDisabled).toBe(true)
    expect(res.approved).toBe(0)
    expect(acquireLog.length).toBe(0)
  })

  test('acquires the approve-commissions lock and returns service result', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const res = await approveJob.runApproveEligibleCommissions({ now: new Date('2026-06-01') })
    expect(acquireLog).toContain('approve-commissions')
    expect(typeof res.approved).toBe('number')
  })

  test('skips when the lock is held in another region', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    lockAcquired = false
    const res = await approveJob.runApproveEligibleCommissions()
    expect(res.lockSkipped).toBe(true)
  })
})

describe('runAffiliatePayoutsCron', () => {
  test('returns flagDisabled when flag is off', async () => {
    const res = await payoutJob.runAffiliatePayoutsCron()
    expect(res.flagDisabled).toBe(true)
  })

  test('acquires affiliate-payouts lock and returns a numeric summary', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const res = await payoutJob.runAffiliatePayoutsCron({ now: new Date('2026-06-01') })
    expect(acquireLog).toContain('affiliate-payouts')
    expect(typeof res.paid).toBe('number')
  })

  test('skips when the lock is held in another region', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    lockAcquired = false
    const res = await payoutJob.runAffiliatePayoutsCron()
    expect(res.lockSkipped).toBe(true)
  })
})

describe('runAffiliateInvoiceReconciliation', () => {
  test('returns empty summary when feature flag is off', async () => {
    const res = await reconJob.runAffiliateInvoiceReconciliation({
      stripeFactory: () => null,
    })
    expect(res.invoicesScanned).toBe(0)
    expect(res.commissionsCreated).toBe(0)
  })

  test('returns empty summary when stripe factory yields null', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const res = await reconJob.runAffiliateInvoiceReconciliation({
      stripeFactory: () => null,
    })
    expect(res.invoicesScanned).toBe(0)
  })

  test('lockSkipped when lock is held', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    lockAcquired = false
    const res = await reconJob.runAffiliateInvoiceReconciliation({
      stripeFactory: () => null,
    })
    expect(res.lockSkipped).toBe(true)
  })
})
