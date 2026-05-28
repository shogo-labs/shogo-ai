// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for src/jobs/affiliate-invoice-reconciliation.ts — daily
// Stripe-invoice -> commission reconciliation cron. The file had ZERO
// dedicated tests before this commit; only the module-load constants
// (export interface + module-level const) were counted as covered.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// withGlobalJobLock — must mock BEFORE the dynamic import. Default mode
// is "acquire and run"; flip to "skip" via lockState.acquired = false.
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

// affiliateService.recordCommissionsForInvoice — returns N for "created
// N commission rows" or throws to simulate a per-invoice failure.
const recordState: {
  perInvoiceCounts: Record<string, number>
  throwOn: Set<string>
} = {
  perInvoiceCounts: {},
  throwOn: new Set(),
}
mock.module('../services/affiliate.service', () => ({
  recordCommissionsForInvoice: mock(
    async (invoice: { id: string }, _stripe: unknown, _now: Date) => {
      if (recordState.throwOn.has(invoice.id)) {
        throw new Error(`forced failure for ${invoice.id}`)
      }
      return recordState.perInvoiceCounts[invoice.id] ?? 0
    },
  ),
}))

// stripe — never imported live in tests because we always pass a
// stripeFactory in options. But the module-level `new Stripe(...)`
// default factory branch IS exercised in one test (stripe key set).
mock.module('stripe', () => ({
  default: class FakeStripeCtor {
    invoices = { list: mock(async () => ({ data: [], has_more: false })) }
  },
}))

const { runAffiliateInvoiceReconciliation, startAffiliateInvoiceReconciliationCron } =
  await import('../jobs/affiliate-invoice-reconciliation')

beforeEach(() => {
  lockState.acquired = true
  recordState.perInvoiceCounts = {}
  recordState.throwOn.clear()
  delete process.env.SHOGO_AFFILIATES_NATIVE
  delete process.env.STRIPE_SECRET_KEY
})

afterEach(() => {
  delete process.env.SHOGO_AFFILIATES_NATIVE
  delete process.env.STRIPE_SECRET_KEY
})

function fakeStripe(pages: Array<Array<{ id: string }>>): {
  factory: () => unknown
  listCalls: Array<Record<string, unknown>>
} {
  const listCalls: Array<Record<string, unknown>> = []
  let pageIdx = 0
  const stripe = {
    invoices: {
      list: mock(async (args: Record<string, unknown>) => {
        listCalls.push(args)
        const data = pages[pageIdx] ?? []
        const has_more = pageIdx < pages.length - 1
        pageIdx++
        return { data, has_more }
      }),
    },
  }
  return { factory: () => stripe, listCalls }
}

describe('runAffiliateInvoiceReconciliation', () => {
  test('lock skipped → returns lockSkipped: true', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    lockState.acquired = false
    const result = await runAffiliateInvoiceReconciliation({})
    expect(result.lockSkipped).toBe(true)
    expect(result.invoicesScanned).toBe(0)
    expect(result.commissionsCreated).toBe(0)
  })

  test('SHOGO_AFFILIATES_NATIVE unset → no-op summary, no stripe call', async () => {
    const { factory, listCalls } = fakeStripe([[{ id: 'in_1' }]])
    const result = await runAffiliateInvoiceReconciliation({ stripeFactory: factory as never })
    expect(result.invoicesScanned).toBe(0)
    expect(listCalls).toHaveLength(0)
  })

  test('SHOGO_AFFILIATES_NATIVE=true + no factory + STRIPE_SECRET_KEY unset → warns + 0 invoices', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const result = await runAffiliateInvoiceReconciliation({})
    expect(result.invoicesScanned).toBe(0)
    expect(result.commissionsCreated).toBe(0)
  })

  test('happy single-page: walks invoices and accumulates commissionsCreated', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    recordState.perInvoiceCounts = { in_1: 1, in_2: 2, in_3: 0 }
    const { factory } = fakeStripe([[{ id: 'in_1' }, { id: 'in_2' }, { id: 'in_3' }]])
    const result = await runAffiliateInvoiceReconciliation({ stripeFactory: factory as never })
    expect(result.invoicesScanned).toBe(3)
    expect(result.commissionsCreated).toBe(3)
    expect(result.failed).toBe(0)
  })

  test('per-invoice failure is counted in summary.failed and does not abort the page', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    recordState.perInvoiceCounts = { in_1: 1, in_2: 2 }
    recordState.throwOn.add('in_bad')
    const { factory } = fakeStripe([[{ id: 'in_1' }, { id: 'in_bad' }, { id: 'in_2' }]])
    const result = await runAffiliateInvoiceReconciliation({ stripeFactory: factory as never })
    expect(result.invoicesScanned).toBe(3)
    expect(result.commissionsCreated).toBe(3)
    expect(result.failed).toBe(1)
  })

  test('paginates via starting_after cursor when has_more=true', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const { factory, listCalls } = fakeStripe([
      [{ id: 'in_a1' }, { id: 'in_a2' }],
      [{ id: 'in_b1' }, { id: 'in_b2' }],
      [{ id: 'in_c1' }],
    ])
    const result = await runAffiliateInvoiceReconciliation({ stripeFactory: factory as never })
    expect(listCalls).toHaveLength(3)
    expect(listCalls[0]!.starting_after).toBeUndefined()
    expect(listCalls[1]!.starting_after).toBe('in_a2')
    expect(listCalls[2]!.starting_after).toBe('in_b2')
    expect(result.invoicesScanned).toBe(5)
  })

  test('breaks immediately on empty first page', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const { factory, listCalls } = fakeStripe([[]])
    const result = await runAffiliateInvoiceReconciliation({ stripeFactory: factory as never })
    expect(listCalls).toHaveLength(1)
    expect(result.invoicesScanned).toBe(0)
  })

  test('windowDays option flows into "since" timestamp', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const { factory, listCalls } = fakeStripe([[]])
    const now = new Date('2026-01-15T00:00:00Z')
    await runAffiliateInvoiceReconciliation({
      now,
      windowDays: 14,
      stripeFactory: factory as never,
    })
    const created = (listCalls[0]!.created as { gte: number }).gte
    const expectedSince = Math.floor(
      (now.getTime() - 14 * 24 * 60 * 60 * 1000) / 1000,
    )
    expect(created).toBe(expectedSince)
  })

  test('default windowDays = 7 when option omitted', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const { factory, listCalls } = fakeStripe([[]])
    const now = new Date('2026-01-15T00:00:00Z')
    await runAffiliateInvoiceReconciliation({
      now,
      stripeFactory: factory as never,
    })
    const created = (listCalls[0]!.created as { gte: number }).gte
    const expectedSince = Math.floor((now.getTime() - 7 * 24 * 60 * 60 * 1000) / 1000)
    expect(created).toBe(expectedSince)
  })

  test('STRIPE_SECRET_KEY set + no factory option → default factory builds a Stripe', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
    // The mocked stripe module's invoices.list returns empty
    const result = await runAffiliateInvoiceReconciliation({})
    expect(result.invoicesScanned).toBe(0)
    expect(result.failed).toBe(0)
  })

  test('stripeFactory returns null → warning branch returns zero summary', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const result = await runAffiliateInvoiceReconciliation({
      stripeFactory: () => null,
    })
    expect(result.invoicesScanned).toBe(0)
  })
})

describe('startAffiliateInvoiceReconciliationCron', () => {
  test('schedules and clears without throwing', async () => {
    const origSetTimeout = globalThis.setTimeout
    const origSetInterval = globalThis.setInterval
    const timeoutCalls: number[] = []
    const intervalCalls: number[] = []
    let capturedTimeoutFn: (() => void) | null = null
    let capturedIntervalFn: (() => void) | null = null
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      timeoutCalls.push(ms)
      capturedTimeoutFn = fn
      return origSetTimeout(() => {}, 0)
    }) as never
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      intervalCalls.push(ms)
      capturedIntervalFn = fn
      return origSetInterval(() => {}, 0) as unknown as NodeJS.Timeout
    }) as never
    try {
      startAffiliateInvoiceReconciliationCron(60_000)
      expect(timeoutCalls).toContain(35_000)
      // Fire the outer setTimeout's callback to execute initial run +
      // schedule the interval. The inner async runAffiliateInvoiceReconciliation
      // call returns immediately (SHOGO_AFFILIATES_NATIVE is unset so it
      // returns the zero summary, .catch() never fires).
      expect(capturedTimeoutFn).not.toBeNull()
      capturedTimeoutFn!()
      expect(intervalCalls).toContain(60_000)
      expect(capturedIntervalFn).not.toBeNull()
      // Fire the interval callback once to cover L137-141.
      capturedIntervalFn!()
      // Yield to microtasks so the .catch() handlers can attach + resolve.
      await new Promise((r) => setImmediate(r))
    } finally {
      globalThis.setTimeout = origSetTimeout
      globalThis.setInterval = origSetInterval
    }
  })
})
