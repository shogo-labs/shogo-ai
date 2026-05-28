// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Greenfield coverage for two affiliate cron-runner job files that
// previously had ZERO dedicated tests:
//
//   - src/jobs/approve-eligible-commissions.ts (67 lines)
//   - src/jobs/run-affiliate-payouts.ts        (62 lines)
//
// Both follow the same shape as
// jobs/affiliate-invoice-reconciliation.ts:
//   feature-flag gate → withGlobalJobLock → call service → return summary
// plus a setTimeout/setInterval cron starter.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const lockState = { acquired: true }
mock.module('../lib/global-job-lock', () => ({
  withGlobalJobLock: mock(
    async (_name: string, fn: () => Promise<unknown>) => {
      if (!lockState.acquired) return { acquired: false, result: null }
      const result = await fn()
      return { acquired: true, result }
    },
  ),
}))

let approveReturn: { approved: number } = { approved: 0 }
let payoutsReturn = {
  affiliatesPaid: 0,
  totalCents: 0,
  failed: 0,
}
let approveThrows = false
let payoutsThrows = false

mock.module('../services/affiliate.service', () => ({
  approveEligibleCommissions: mock(async (_now: Date) => {
    if (approveThrows) throw new Error('approve service failed')
    return approveReturn
  }),
  runAffiliatePayouts: mock(async (_now: Date) => {
    if (payoutsThrows) throw new Error('payouts service failed')
    return payoutsReturn
  }),
}))

const {
  runApproveEligibleCommissions,
  startApproveEligibleCommissionsCron,
} = await import('../jobs/approve-eligible-commissions')
const {
  runAffiliatePayoutsCron,
  startAffiliatePayoutsCron,
} = await import('../jobs/run-affiliate-payouts')

beforeEach(() => {
  lockState.acquired = true
  approveReturn = { approved: 0 }
  payoutsReturn = { affiliatesPaid: 0, totalCents: 0, failed: 0 }
  approveThrows = false
  payoutsThrows = false
  delete process.env.SHOGO_AFFILIATES_NATIVE
})

afterEach(() => {
  delete process.env.SHOGO_AFFILIATES_NATIVE
})

describe('runApproveEligibleCommissions', () => {
  test('SHOGO_AFFILIATES_NATIVE unset → flagDisabled:true short-circuit', async () => {
    const r = await runApproveEligibleCommissions()
    expect(r.flagDisabled).toBe(true)
    expect(r.approved).toBe(0)
  })

  test('SHOGO_AFFILIATES_NATIVE=true + lock acquired → returns service result', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    approveReturn = { approved: 42 }
    const r = await runApproveEligibleCommissions()
    expect(r.approved).toBe(42)
    expect(r.lockSkipped).toBeUndefined()
    expect(r.flagDisabled).toBeUndefined()
  })

  test('lock not acquired → lockSkipped:true', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    lockState.acquired = false
    const r = await runApproveEligibleCommissions()
    expect(r.approved).toBe(0)
    expect(r.lockSkipped).toBe(true)
  })

  test('uses opts.now when provided, else new Date()', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const now = new Date('2026-02-01T00:00:00Z')
    await runApproveEligibleCommissions({ now })
    // Just verifies no crash on explicit now; the service mock doesn't
    // assert which now it received (would require deeper bookkeeping)
    await runApproveEligibleCommissions({})
  })
})

describe('runAffiliatePayoutsCron', () => {
  test('SHOGO_AFFILIATES_NATIVE unset → flagDisabled:true', async () => {
    const r = await runAffiliatePayoutsCron()
    expect(r.flagDisabled).toBe(true)
  })

  test('flag set + lock acquired → returns service payout summary', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    payoutsReturn = { affiliatesPaid: 3, totalCents: 1234, failed: 0 }
    const r = await runAffiliatePayoutsCron()
    expect(r.affiliatesPaid).toBe(3)
    expect(r.totalCents).toBe(1234)
    expect(r.lockSkipped).toBeUndefined()
  })

  test('lock not acquired → lockSkipped:true', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    lockState.acquired = false
    const r = await runAffiliatePayoutsCron()
    expect(r.lockSkipped).toBe(true)
  })

  test('explicit opts.now is plumbed (smoke test)', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    await runAffiliatePayoutsCron({ now: new Date('2026-03-15T00:00:00Z') })
  })
})

describe('startApproveEligibleCommissionsCron — timer wiring', () => {
  test('schedules outer setTimeout(30000) + interval(1h default); fires both callbacks', async () => {
    const origSetTimeout = globalThis.setTimeout
    const origSetInterval = globalThis.setInterval
    const timeoutCalls: number[] = []
    const intervalCalls: number[] = []
    let outerFn: (() => void) | null = null
    let intervalFn: (() => void) | null = null
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      timeoutCalls.push(ms)
      outerFn = fn
      return origSetTimeout(() => {}, 0)
    }) as never
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      intervalCalls.push(ms)
      intervalFn = fn
      return origSetInterval(() => {}, 0) as unknown as NodeJS.Timeout
    }) as never
    try {
      startApproveEligibleCommissionsCron()
      expect(timeoutCalls).toContain(30_000)
      outerFn!()
      expect(intervalCalls).toContain(60 * 60 * 1000)
      intervalFn!()
      await new Promise((r) => setImmediate(r))
    } finally {
      globalThis.setTimeout = origSetTimeout
      globalThis.setInterval = origSetInterval
    }
  })

  test('initial-run failure is caught (covers .catch arm)', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    approveThrows = true
    const origSetTimeout = globalThis.setTimeout
    const origSetInterval = globalThis.setInterval
    let outerFn: (() => void) | null = null
    let intervalFn: (() => void) | null = null
    globalThis.setTimeout = ((fn: () => void) => {
      outerFn = fn
      return origSetTimeout(() => {}, 0)
    }) as never
    globalThis.setInterval = ((fn: () => void) => {
      intervalFn = fn
      return origSetInterval(() => {}, 0) as unknown as NodeJS.Timeout
    }) as never
    const origError = console.error
    const errCalls: unknown[][] = []
    console.error = (...args: unknown[]) => { errCalls.push(args) }
    try {
      startApproveEligibleCommissionsCron(1000)
      outerFn!()
      intervalFn!()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(errCalls.length).toBeGreaterThanOrEqual(2)
    } finally {
      globalThis.setTimeout = origSetTimeout
      globalThis.setInterval = origSetInterval
      console.error = origError
    }
  })
})

describe('startAffiliatePayoutsCron — timer wiring', () => {
  test('schedules outer setTimeout(40000) + interval(24h default); fires both callbacks', async () => {
    const origSetTimeout = globalThis.setTimeout
    const origSetInterval = globalThis.setInterval
    const timeoutCalls: number[] = []
    const intervalCalls: number[] = []
    let outerFn: (() => void) | null = null
    let intervalFn: (() => void) | null = null
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      timeoutCalls.push(ms)
      outerFn = fn
      return origSetTimeout(() => {}, 0)
    }) as never
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      intervalCalls.push(ms)
      intervalFn = fn
      return origSetInterval(() => {}, 0) as unknown as NodeJS.Timeout
    }) as never
    try {
      startAffiliatePayoutsCron()
      expect(timeoutCalls).toContain(40_000)
      outerFn!()
      expect(intervalCalls).toContain(24 * 60 * 60 * 1000)
      intervalFn!()
      await new Promise((r) => setImmediate(r))
    } finally {
      globalThis.setTimeout = origSetTimeout
      globalThis.setInterval = origSetInterval
    }
  })

  test('initial-run failure is caught (covers .catch arm)', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    payoutsThrows = true
    const origSetTimeout = globalThis.setTimeout
    const origSetInterval = globalThis.setInterval
    let outerFn: (() => void) | null = null
    let intervalFn: (() => void) | null = null
    globalThis.setTimeout = ((fn: () => void) => {
      outerFn = fn
      return origSetTimeout(() => {}, 0)
    }) as never
    globalThis.setInterval = ((fn: () => void) => {
      intervalFn = fn
      return origSetInterval(() => {}, 0) as unknown as NodeJS.Timeout
    }) as never
    const origError = console.error
    const errCalls: unknown[][] = []
    console.error = (...args: unknown[]) => { errCalls.push(args) }
    try {
      startAffiliatePayoutsCron(1000)
      outerFn!()
      intervalFn!()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(errCalls.length).toBeGreaterThanOrEqual(2)
    } finally {
      globalThis.setTimeout = origSetTimeout
      globalThis.setInterval = origSetInterval
      console.error = origError
    }
  })
})
