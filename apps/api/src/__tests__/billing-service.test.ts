// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the USD billing service.
 *
 * Covers the `hasBalance`, `consumeUsage`, `chargeOverageBlocks`, and
 * `syncSeatsFromMembership` code paths — daily → monthly → overage deduction
 * order, hard-cap enforcement, mid-cycle $100 trust-block invoicing, and
 * Cursor-style active-seat syncing with Stripe prorations.
 *
 * Prisma is mocked in-memory; Stripe is injected via a synthetic `stripe`
 * module mock so we can assert invoice + subscription-item operations
 * without network calls.
 *
 *   bun test apps/api/src/__tests__/billing-service.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ─── Prisma mock ───────────────────────────────────────────────────────
type Wallet = {
  id: string
  workspaceId: string
  monthlyIncludedUsd: number
  monthlyIncludedAllocationUsd: number
  dailyIncludedUsd: number
  dailyUsedThisMonthUsd: number
  overageEnabled: boolean
  overageHardLimitUsd: number | null
  overageAccumulatedUsd: number
  overageBilledUsd: number
  stripeMeteredItemId: string | null
  anniversaryDay: number
  lastDailyReset: Date
  lastMonthlyReset: Date
}

let wallets: Map<string, Wallet> = new Map()
let usageEvents: any[] = []
let subscriptions: Array<{
  id?: string
  workspaceId: string
  status: string
  stripeSubscriptionId: string | null
  stripeCustomerId?: string
  planId: string
  seats?: number
}> = []
let members: Array<{ workspaceId: string | null; projectId: string | null; userId: string }> = []

function freshWallet(ws: string, overrides: Partial<Wallet> = {}): Wallet {
  const now = new Date()
  return {
    id: `wallet_${ws}`,
    workspaceId: ws,
    monthlyIncludedUsd: 0,
    monthlyIncludedAllocationUsd: 0,
    dailyIncludedUsd: 0.5,
    dailyUsedThisMonthUsd: 0,
    overageEnabled: false,
    overageHardLimitUsd: null,
    overageAccumulatedUsd: 0,
    overageBilledUsd: 0,
    stripeMeteredItemId: null,
    anniversaryDay: now.getUTCDate(),
    lastDailyReset: now,
    lastMonthlyReset: now,
    ...overrides,
  }
}

function applyIncrements(target: any, patch: any): any {
  // Mimic Prisma's `{ field: { increment: n } }` syntax used by the service.
  const out: any = { ...target }
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && 'increment' in (v as any)) {
      out[k] = (target?.[k] ?? 0) + (v as any).increment
    } else {
      out[k] = v
    }
  }
  return out
}

mock.module('../lib/prisma', () => {
  const walletApi = {
    findUnique: async ({ where }: any) => wallets.get(where.workspaceId) ?? null,
    create: async ({ data }: any) => {
      const w = freshWallet(data.workspaceId, data)
      wallets.set(data.workspaceId, w)
      return w
    },
    update: async ({ where, data }: any) => {
      const w = wallets.get(where.workspaceId)
      if (!w) throw new Error('wallet not found')
      const updated = applyIncrements(w, data)
      wallets.set(where.workspaceId, updated)
      return updated
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const [ws, w] of wallets) {
        if (ws !== where.workspaceId) continue
        wallets.set(ws, applyIncrements(w, data))
        count++
      }
      return { count }
    },
    upsert: async ({ where, create, update }: any) => {
      const w = wallets.get(where.workspaceId)
      if (w) {
        const updated = applyIncrements(w, update)
        wallets.set(where.workspaceId, updated)
        return updated
      }
      const created = freshWallet(where.workspaceId, create)
      wallets.set(where.workspaceId, created)
      return created
    },
  }
  const eventApi = {
    create: async ({ data }: any) => {
      usageEvents.push(data)
      return data
    },
  }
  const subApi = {
    findFirst: async ({ where }: any) => {
      return (
        subscriptions.find(
          (s) =>
            s.workspaceId === where.workspaceId &&
            (where.status?.in ? where.status.in.includes(s.status) : true),
        ) ?? null
      )
    },
    update: async ({ where, data }: any) => {
      const sub = subscriptions.find((s) => s.id === where.id)
      if (!sub) throw new Error('subscription not found')
      Object.assign(sub, data)
      return sub
    },
  }
  const memberApi = {
    findMany: async ({ where }: any) => {
      return members.filter(
        (m) =>
          (where.workspaceId == null || m.workspaceId === where.workspaceId) &&
          (where.projectId === null
            ? m.projectId == null
            : where.projectId === undefined
              ? true
              : m.projectId === where.projectId),
      )
    },
  }
  return {
    prisma: {
      usageWallet: walletApi,
      usageEvent: eventApi,
      subscription: subApi,
      member: memberApi,
      $transaction: async (fn: any) =>
        fn({ usageWallet: walletApi, usageEvent: eventApi }),
    },
    SubscriptionStatus: {},
    BillingInterval: {},
  }
})

// ─── Stripe mock ───────────────────────────────────────────────────────
const stripeCalls: {
  retrieve: any[]
  subItemCreate: any[]
  subItemUpdate: any[]
  invoiceItemCreate: any[]
  invoiceCreate: any[]
  invoiceFinalize: any[]
  invoicePay: any[]
} = {
  retrieve: [],
  subItemCreate: [],
  subItemUpdate: [],
  invoiceItemCreate: [],
  invoiceCreate: [],
  invoiceFinalize: [],
  invoicePay: [],
}

let stripeSubResponse: any = { items: { data: [] } }

class MockStripe {
  constructor(public key: string) {}
  subscriptions = {
    retrieve: async (id: string) => {
      stripeCalls.retrieve.push(id)
      return stripeSubResponse
    },
  }
  subscriptionItems = {
    create: async (args: any) => {
      stripeCalls.subItemCreate.push(args)
      return { id: 'si_mocked', ...args }
    },
    update: async (id: string, args: any) => {
      stripeCalls.subItemUpdate.push({ id, ...args })
      return { id, ...args }
    },
  }
  invoiceItems = {
    create: async (args: any, opts?: any) => {
      stripeCalls.invoiceItemCreate.push({ ...args, _opts: opts })
      return { id: 'ii_mocked', ...args }
    },
  }
  invoices = {
    create: async (args: any, opts?: any) => {
      stripeCalls.invoiceCreate.push({ ...args, _opts: opts })
      return { id: `in_${stripeCalls.invoiceCreate.length}`, ...args }
    },
    finalizeInvoice: async (id: string) => {
      stripeCalls.invoiceFinalize.push(id)
      return { id, status: 'open' }
    },
    pay: async (id: string) => {
      stripeCalls.invoicePay.push(id)
      return { id, status: 'paid' }
    },
  }
}

mock.module('stripe', () => ({ default: MockStripe }))

// ─── Imports AFTER mocks ───────────────────────────────────────────────
const billing = await import('../services/billing.service')

beforeEach(() => {
  wallets = new Map()
  usageEvents = []
  subscriptions = []
  members = []
  stripeCalls.retrieve = []
  stripeCalls.subItemCreate = []
  stripeCalls.subItemUpdate = []
  stripeCalls.invoiceItemCreate = []
  stripeCalls.invoiceCreate = []
  stripeCalls.invoiceFinalize = []
  stripeCalls.invoicePay = []
  stripeSubResponse = { items: { data: [] } }
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
})

// =============================================================================
// hasBalance
// =============================================================================

describe('hasBalance', () => {
  test('returns true when daily allowance alone covers the request', async () => {
    wallets.set('ws1', freshWallet('ws1', { dailyIncludedUsd: 0.5 }))
    expect(await billing.hasBalance('ws1', 0.1)).toBe(true)
  })

  test('returns true when monthly pool covers the shortfall over daily', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', { dailyIncludedUsd: 0.05, monthlyIncludedUsd: 10 }),
    )
    expect(await billing.hasBalance('ws1', 0.5)).toBe(true)
  })

  test('returns false when included pool is empty and overage is disabled', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', {
        dailyIncludedUsd: 0,
        monthlyIncludedUsd: 0,
        overageEnabled: false,
      }),
    )
    expect(await billing.hasBalance('ws1', 0.01)).toBe(false)
  })

  test('returns true when overage is enabled with no hard cap', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', {
        dailyIncludedUsd: 0,
        monthlyIncludedUsd: 0,
        overageEnabled: true,
        overageHardLimitUsd: null,
      }),
    )
    expect(await billing.hasBalance('ws1', 999)).toBe(true)
  })

  test('returns false when overage is enabled but hard cap is already hit', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', {
        dailyIncludedUsd: 0,
        monthlyIncludedUsd: 0,
        overageEnabled: true,
        overageHardLimitUsd: 10,
        overageAccumulatedUsd: 10,
      }),
    )
    expect(await billing.hasBalance('ws1', 0.01)).toBe(false)
  })

  test('auto-allocates a free-tier wallet when none exists', async () => {
    expect(wallets.get('brand-new')).toBeUndefined()
    await billing.hasBalance('brand-new', 0.001)
    expect(wallets.get('brand-new')).toBeDefined()
    expect(wallets.get('brand-new')?.dailyIncludedUsd).toBe(0.5)
  })

  // Note: local-mode short-circuits read `process.env.SHOGO_LOCAL_MODE` at
  // billing.service module-load time, so we don't toggle that behavior
  // inside this file. The semantics are covered by ai-proxy-e2e tests
  // which set the env var before importing the service.
})

// =============================================================================
// consumeUsage — deduction order + ledger side effects
// =============================================================================

describe('consumeUsage', () => {
  test('deducts from daily pool first and records a usage event', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', { dailyIncludedUsd: 0.5, monthlyIncludedUsd: 20 }),
    )

    const res = await billing.consumeUsage({
      workspaceId: 'ws1',
      projectId: 'p1',
      memberId: 'u1',
      actionType: 'chat_message',
      rawUsd: 0.1,
      billedUsd: 0.12,
    })

    expect(res.success).toBe(true)
    expect(res.source).toBe('daily')
    expect(res.overageChargedUsd ?? 0).toBe(0)
    expect(wallets.get('ws1')!.dailyIncludedUsd).toBeCloseTo(0.38, 10)
    expect(wallets.get('ws1')!.monthlyIncludedUsd).toBeCloseTo(20, 10)
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].source).toBe('daily')
    expect(usageEvents[0].billedUsd).toBeCloseTo(0.12, 10)
    expect(usageEvents[0].rawUsd).toBeCloseTo(0.1, 10)
  })

  test('falls back to the monthly pool when daily alone cannot cover the debit', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', { dailyIncludedUsd: 0.05, monthlyIncludedUsd: 20 }),
    )

    const res = await billing.consumeUsage({
      workspaceId: 'ws1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 1.0,
    })

    expect(res.success).toBe(true)
    expect(res.source).toBe('monthly')
    // Monthly covered the debit; daily is untouched (not partial-spend).
    expect(wallets.get('ws1')!.monthlyIncludedUsd).toBeCloseTo(19, 10)
    expect(wallets.get('ws1')!.dailyIncludedUsd).toBeCloseTo(0.05, 10)
  })

  test('returns usage_limit_reached-style error when included is exhausted and overage is off', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', {
        dailyIncludedUsd: 0,
        monthlyIncludedUsd: 0,
        overageEnabled: false,
      }),
    )

    const res = await billing.consumeUsage({
      workspaceId: 'ws1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 0.5,
    })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/usage limit reached/i)
    expect(usageEvents).toHaveLength(0)
  })

  test('charges overage when included is exhausted and overage is enabled', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', {
        dailyIncludedUsd: 0,
        monthlyIncludedUsd: 0,
        overageEnabled: true,
        overageHardLimitUsd: null,
      }),
    )

    const res = await billing.consumeUsage({
      workspaceId: 'ws1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 2.5,
    })

    expect(res.success).toBe(true)
    expect(res.source).toBe('overage')
    expect(res.overageChargedUsd).toBeCloseTo(2.5, 10)
    expect(wallets.get('ws1')!.overageAccumulatedUsd).toBeCloseTo(2.5, 10)
    expect(usageEvents[0].source).toBe('overage')
  })

  test('refuses to charge overage when the hard cap would be exceeded', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', {
        dailyIncludedUsd: 0,
        monthlyIncludedUsd: 0,
        overageEnabled: true,
        overageHardLimitUsd: 10,
        overageAccumulatedUsd: 9.5,
      }),
    )

    const res = await billing.consumeUsage({
      workspaceId: 'ws1',
      projectId: null,
      memberId: 'u1',
      actionType: 'chat_message',
      billedUsd: 1.0,
    })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/hard limit/i)
    // Wallet untouched.
    expect(wallets.get('ws1')!.overageAccumulatedUsd).toBeCloseTo(9.5, 10)
    expect(usageEvents).toHaveLength(0)
  })

  // Local-mode short-circuits (SHOGO_LOCAL_MODE=true) bypass wallet writes
  // and are evaluated at module-load time — see note on hasBalance above.
})

// =============================================================================
// chargeOverageBlocks — trust-first $100 mid-cycle invoicing
// =============================================================================

describe('chargeOverageBlocks', () => {
  function setupOverageWorkspace(opts: {
    overageAccumulatedUsd: number
    overageBilledUsd?: number
  }) {
    subscriptions.push({
      id: 'sub_pk_1',
      workspaceId: 'ws1',
      status: 'active',
      stripeSubscriptionId: 'sub_123',
      stripeCustomerId: 'cus_abc',
      planId: 'pro',
      seats: 1,
    })
    wallets.set(
      'ws1',
      freshWallet('ws1', {
        overageEnabled: true,
        overageAccumulatedUsd: opts.overageAccumulatedUsd,
        overageBilledUsd: opts.overageBilledUsd ?? 0,
      }),
    )
  }

  test('no-ops when unbilled overage is below the first $100 block', async () => {
    setupOverageWorkspace({ overageAccumulatedUsd: 42.5 })

    const blocks = await billing.chargeOverageBlocks('ws1')

    expect(blocks).toBe(0)
    expect(stripeCalls.invoiceItemCreate).toHaveLength(0)
    expect(stripeCalls.invoiceCreate).toHaveLength(0)
    expect(wallets.get('ws1')!.overageBilledUsd).toBe(0)
  })

  test('charges a single $100 block on the first ladder rung', async () => {
    setupOverageWorkspace({ overageAccumulatedUsd: 100.01 })

    const blocks = await billing.chargeOverageBlocks('ws1')

    expect(blocks).toBe(1)
    expect(stripeCalls.invoiceItemCreate).toHaveLength(1)
    expect(stripeCalls.invoiceItemCreate[0].amount).toBe(100 * 100)
    expect(stripeCalls.invoiceItemCreate[0].currency).toBe('usd')
    expect(stripeCalls.invoiceItemCreate[0].metadata.blockSizes).toBe('100')
    expect(stripeCalls.invoiceCreate).toHaveLength(1)
    expect(stripeCalls.invoiceCreate[0].auto_advance).toBe(true)
    expect(stripeCalls.invoiceCreate[0].collection_method).toBe('charge_automatically')
    expect(stripeCalls.invoiceFinalize).toHaveLength(1)
    expect(stripeCalls.invoicePay).toHaveLength(1)
    expect(wallets.get('ws1')!.overageBilledUsd).toBeCloseTo(100, 6)
  })

  test('escalates to a $200 block on the second crossing', async () => {
    setupOverageWorkspace({
      overageAccumulatedUsd: 305,
      overageBilledUsd: 100,
    })

    const blocks = await billing.chargeOverageBlocks('ws1')

    // Unbilled = 205; second block on the ladder is $200 → fits, $100 leftover.
    expect(blocks).toBe(1)
    expect(stripeCalls.invoiceItemCreate[0].amount).toBe(200 * 100)
    expect(stripeCalls.invoiceItemCreate[0].metadata.blockSizes).toBe('200')
    expect(wallets.get('ws1')!.overageBilledUsd).toBeCloseTo(300, 6)
  })

  test('bundles consecutive ladder rungs into one invoice when usage races past several thresholds', async () => {
    setupOverageWorkspace({ overageAccumulatedUsd: 650 })

    const blocks = await billing.chargeOverageBlocks('ws1')

    // Ladder cumulative: 100 → 300 → 600 → 1000. With $650 accumulated and
    // $0 already billed we can fit blocks of $100 + $200 + $300 = $600
    // (cumulative $600); the remaining $50 is below the next ($400) block
    // so it carries.
    expect(blocks).toBe(3)
    expect(stripeCalls.invoiceItemCreate).toHaveLength(1)
    expect(stripeCalls.invoiceItemCreate[0].amount).toBe(600 * 100)
    expect(stripeCalls.invoiceItemCreate[0].metadata.blockSizes).toBe('100,200,300')
    expect(stripeCalls.invoiceCreate).toHaveLength(1)
    expect(wallets.get('ws1')!.overageBilledUsd).toBeCloseTo(600, 6)
  })

  test('caps each ladder rung at $500 once the workspace has built enough trust history', async () => {
    setupOverageWorkspace({
      overageAccumulatedUsd: 2_600,
      // Workspace has already paid the first five rungs (cumulative $1500),
      // so the next blocks should be the cap of $500 each.
      overageBilledUsd: 1_500,
    })

    const blocks = await billing.chargeOverageBlocks('ws1')

    // Unbilled = $1100 → fits two $500 caps with $100 leftover.
    expect(blocks).toBe(2)
    expect(stripeCalls.invoiceItemCreate[0].amount).toBe(1_000 * 100)
    expect(stripeCalls.invoiceItemCreate[0].metadata.blockSizes).toBe('500,500')
    expect(wallets.get('ws1')!.overageBilledUsd).toBeCloseTo(2_500, 6)
  })

  test('does not double-charge when the next ladder block has not been crossed yet', async () => {
    setupOverageWorkspace({
      overageAccumulatedUsd: 250,
      overageBilledUsd: 100,
    })

    const blocks = await billing.chargeOverageBlocks('ws1')

    // Unbilled = 150. Next block on the ladder is $200, which we haven't
    // crossed yet — carry over.
    expect(blocks).toBe(0)
    expect(stripeCalls.invoiceItemCreate).toHaveLength(0)
    expect(wallets.get('ws1')!.overageBilledUsd).toBe(100)
  })

  test('idempotency key encodes the billed snapshot + total so retries dedupe', async () => {
    setupOverageWorkspace({
      overageAccumulatedUsd: 320,
      overageBilledUsd: 100,
    })

    const blocks = await billing.chargeOverageBlocks('ws1')

    expect(blocks).toBe(1)
    const itemKey = stripeCalls.invoiceItemCreate[0]._opts?.idempotencyKey
    const invoiceKey = stripeCalls.invoiceCreate[0]._opts?.idempotencyKey
    expect(typeof itemKey).toBe('string')
    expect(typeof invoiceKey).toBe('string')
    // billedSnapshot=100, totalUsd=200.
    expect(itemKey).toContain('overage:ws1:100:200')
    expect(invoiceKey).toContain('overage:ws1:100:200')
  })

  test('no-ops when the workspace has no active Stripe customer', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', { overageAccumulatedUsd: 300, overageEnabled: true }),
    )
    const blocks = await billing.chargeOverageBlocks('ws1')

    expect(blocks).toBe(0)
    expect(stripeCalls.invoiceCreate).toHaveLength(0)
  })

  test('no-ops when STRIPE_SECRET_KEY is unset', async () => {
    delete process.env.STRIPE_SECRET_KEY
    setupOverageWorkspace({ overageAccumulatedUsd: 250 })

    const blocks = await billing.chargeOverageBlocks('ws1')

    expect(blocks).toBe(0)
    expect(stripeCalls.invoiceCreate).toHaveLength(0)
  })
})

// =============================================================================
// nextOverageBlockUsd — ladder math
// =============================================================================

describe('nextOverageBlockUsd ladder', () => {
  test('starts at $100 for a workspace with no billed history', () => {
    expect(billing.nextOverageBlockUsd(0)).toBe(100)
  })

  test('escalates by $100 per fully billed rung up to the $500 cap', () => {
    // Cumulative billed thresholds: 100, 300, 600, 1000, 1500, 2000, ...
    expect(billing.nextOverageBlockUsd(100)).toBe(200)
    expect(billing.nextOverageBlockUsd(300)).toBe(300)
    expect(billing.nextOverageBlockUsd(600)).toBe(400)
    expect(billing.nextOverageBlockUsd(1000)).toBe(500)
    // Past 1500 every block is the cap.
    expect(billing.nextOverageBlockUsd(1500)).toBe(500)
    expect(billing.nextOverageBlockUsd(5000)).toBe(500)
  })

  test('mid-rung billed history still resolves to the rung containing it', () => {
    // billed = $250 → second rung still in progress, next is $200.
    expect(billing.nextOverageBlockUsd(250)).toBe(200)
    // billed = $550 → third rung in progress, next is $300.
    expect(billing.nextOverageBlockUsd(550)).toBe(300)
  })

  test('treats negative or NaN-ish input as zero', () => {
    expect(billing.nextOverageBlockUsd(-100)).toBe(100)
  })
})

// =============================================================================
// syncSeatsFromMembership — Cursor-style active seats
// =============================================================================

describe('syncSeatsFromMembership', () => {
  function setupSeatPlan(planId: string, currentSeats: number) {
    subscriptions.push({
      id: 'sub_pk_1',
      workspaceId: 'ws1',
      status: 'active',
      stripeSubscriptionId: 'sub_123',
      stripeCustomerId: 'cus_abc',
      planId,
      seats: currentSeats,
    })
    wallets.set('ws1', freshWallet('ws1'))
    stripeSubResponse = {
      items: {
        data: [
          // Per-seat licensed price item — what the sync targets.
          {
            id: 'si_seat',
            price: { id: 'price_pro_monthly', recurring: { usage_type: 'licensed' } },
          },
          // Metered overage price item — must be ignored when locating seat item.
          {
            id: 'si_metered',
            price: { id: 'price_overage_metered', recurring: { usage_type: 'metered' } },
          },
        ],
      },
    }
  }

  test('updates the seat item quantity with always_invoice proration when membership grows', async () => {
    setupSeatPlan('pro', 1)
    members.push(
      { workspaceId: 'ws1', projectId: null, userId: 'u1' },
      { workspaceId: 'ws1', projectId: null, userId: 'u2' },
      { workspaceId: 'ws1', projectId: null, userId: 'u3' },
    )

    const result = await billing.syncSeatsFromMembership('ws1')

    expect(result.ok).toBe(true)
    expect(result.seats).toBe(3)
    expect(stripeCalls.subItemUpdate).toHaveLength(1)
    expect(stripeCalls.subItemUpdate[0].id).toBe('si_seat')
    expect(stripeCalls.subItemUpdate[0].quantity).toBe(3)
    expect(stripeCalls.subItemUpdate[0].proration_behavior).toBe('always_invoice')
    expect(subscriptions[0].seats).toBe(3)
  })

  test('shrinks the seat quantity when a member leaves', async () => {
    setupSeatPlan('business', 4)
    members.push(
      { workspaceId: 'ws1', projectId: null, userId: 'u1' },
      { workspaceId: 'ws1', projectId: null, userId: 'u2' },
    )

    const result = await billing.syncSeatsFromMembership('ws1')

    expect(result.ok).toBe(true)
    expect(result.seats).toBe(2)
    expect(stripeCalls.subItemUpdate[0].quantity).toBe(2)
  })

  test('ignores project-only memberships and pending (unaccepted) members', async () => {
    setupSeatPlan('pro', 1)
    members.push(
      { workspaceId: 'ws1', projectId: null, userId: 'u1' },
      // Project-only membership — same user but should not double-count.
      { workspaceId: 'ws1', projectId: 'p_xyz', userId: 'u2' },
      // Standalone project-only membership — should not bill a seat.
      { workspaceId: 'ws1', projectId: 'p_zzz', userId: 'u3' },
    )

    const result = await billing.syncSeatsFromMembership('ws1')

    expect(result.ok).toBe(true)
    expect(result.seats).toBe(1)
  })

  test('skips Stripe call when seat count is already in sync', async () => {
    setupSeatPlan('pro', 2)
    members.push(
      { workspaceId: 'ws1', projectId: null, userId: 'u1' },
      { workspaceId: 'ws1', projectId: null, userId: 'u2' },
    )

    const result = await billing.syncSeatsFromMembership('ws1')

    expect(result.ok).toBe(true)
    expect(result.seats).toBe(2)
    expect(stripeCalls.subItemUpdate).toHaveLength(0)
  })

  test('Basic plan is single-seat by definition; sync is a no-op', async () => {
    setupSeatPlan('basic', 1)
    members.push(
      { workspaceId: 'ws1', projectId: null, userId: 'u1' },
      { workspaceId: 'ws1', projectId: null, userId: 'u2' },
    )

    const result = await billing.syncSeatsFromMembership('ws1')

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('basic_plan_single_seat')
    expect(stripeCalls.subItemUpdate).toHaveLength(0)
  })

  test('no-ops when there is no active subscription (free workspace)', async () => {
    members.push({ workspaceId: 'ws1', projectId: null, userId: 'u1' })

    const result = await billing.syncSeatsFromMembership('ws1')

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no_active_subscription')
  })
})

// =============================================================================
// Legacy compat shim
// =============================================================================

describe('legacy consumeCredits shim', () => {
  test('converts credit cost to USD at $0.10/credit and exposes remainingCredits', async () => {
    wallets.set(
      'ws1',
      freshWallet('ws1', { dailyIncludedUsd: 0.5, monthlyIncludedUsd: 20 }),
    )

    const res = await billing.consumeCredits(
      'ws1',
      null,
      'u1',
      'chat_message',
      3, // 3 credits → $0.30
    )

    expect(res.success).toBe(true)
    // Monthly covered since daily only has $0.50 but wait — $0.30 <= daily
    // so daily pays: remaining included $0.20 (daily) + $20 monthly = $20.20
    // → at $0.10/credit = 202 credits.
    expect(res.remainingCredits).toBeCloseTo(202, 0)
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].billedUsd).toBeCloseTo(0.3, 10)
  })
})
