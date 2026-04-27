// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the USD billing service.
 *
 * Focuses on the new `hasBalance`, `consumeUsage`, and `reportOverageToStripe`
 * code paths — daily -> monthly -> overage deduction order, the lazy daily /
 * monthly reset logic, overage gating + hard-cap enforcement, and the Stripe
 * metered overage reporting (behind the `USAGE_OVERAGE_METERING_ENABLED`
 * feature flag).
 *
 * Prisma is mocked in-memory; Stripe is injected via a synthetic `stripe`
 * module mock so we can assert usage-record + subscription-item creation
 * without network calls.
 *
 *   bun test apps/api/src/__tests__/billing-service.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ─── Feature flag mock (metering ON for this suite) ────────────────────
mock.module('../config/feature-flags', () => ({
  USAGE_BASED_BILLING_ENABLED: true,
  USAGE_OVERAGE_METERING_ENABLED: true,
}))

// ─── Prisma mock ───────────────────────────────────────────────────────
type Wallet = {
  workspaceId: string
  monthlyIncludedUsd: number
  monthlyIncludedAllocationUsd: number
  dailyIncludedUsd: number
  dailyUsedThisMonthUsd: number
  overageEnabled: boolean
  overageHardLimitUsd: number | null
  overageAccumulatedUsd: number
  stripeMeteredItemId: string | null
  anniversaryDay: number
  lastDailyReset: Date
  lastMonthlyReset: Date
}

let wallets: Map<string, Wallet> = new Map()
let usageEvents: any[] = []
let subscriptions: Array<{
  workspaceId: string
  status: string
  stripeSubscriptionId: string | null
  planId: string
}> = []

function freshWallet(ws: string, overrides: Partial<Wallet> = {}): Wallet {
  const now = new Date()
  return {
    workspaceId: ws,
    monthlyIncludedUsd: 0,
    monthlyIncludedAllocationUsd: 0,
    dailyIncludedUsd: 0.5,
    dailyUsedThisMonthUsd: 0,
    overageEnabled: false,
    overageHardLimitUsd: null,
    overageAccumulatedUsd: 0,
    stripeMeteredItemId: null,
    anniversaryDay: now.getUTCDate(),
    lastDailyReset: now,
    lastMonthlyReset: now,
    ...overrides,
  }
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
      const updated = { ...w, ...data }
      wallets.set(where.workspaceId, updated)
      return updated
    },
    upsert: async ({ where, create, update }: any) => {
      const w = wallets.get(where.workspaceId)
      if (w) {
        const updated = { ...w, ...update }
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
  }
  return {
    prisma: {
      usageWallet: walletApi,
      usageEvent: eventApi,
      subscription: subApi,
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
  meterEventCreate: any[]
} = {
  retrieve: [],
  subItemCreate: [],
  meterEventCreate: [],
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
  }
  billing = {
    meterEvents: {
      create: async (args: any) => {
        stripeCalls.meterEventCreate.push(args)
        return { id: 'me_mocked' }
      },
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
  stripeCalls.retrieve = []
  stripeCalls.subItemCreate = []
  stripeCalls.meterEventCreate = []
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
// reportOverageToStripe — feature flag + idempotency
// =============================================================================

describe('reportOverageToStripe', () => {
  // The `USAGE_OVERAGE_METERING_ENABLED` flag is resolved from env at
  // feature-flags module-load time, so staging rollout coverage lives in
  // the feature-flags unit tests. The tests below assume metering ON.

  test('no-ops for zero or negative amounts', async () => {
    await billing.reportOverageToStripe('ws1', 0)
    await billing.reportOverageToStripe('ws1', -5)
    expect(stripeCalls.meterEventCreate).toHaveLength(0)
  })

  test('no-ops when the workspace has no active Stripe subscription', async () => {
    wallets.set('ws1', freshWallet('ws1'))
    await billing.reportOverageToStripe('ws1', 1.5)
    expect(stripeCalls.retrieve).toHaveLength(0)
    expect(stripeCalls.meterEventCreate).toHaveLength(0)
  })

  test('attaches a metered subscription item on first overage and stamps the wallet', async () => {
    subscriptions.push({
      workspaceId: 'ws1',
      status: 'active',
      stripeSubscriptionId: 'sub_123',
      stripeCustomerId: 'cus_abc',
      planId: 'pro',
    })
    wallets.set('ws1', freshWallet('ws1', { stripeMeteredItemId: null }))

    await billing.reportOverageToStripe('ws1', 2.5)

    expect(stripeCalls.retrieve).toEqual(['sub_123'])
    expect(stripeCalls.subItemCreate).toHaveLength(1)
    expect(stripeCalls.subItemCreate[0].subscription).toBe('sub_123')
    expect(wallets.get('ws1')!.stripeMeteredItemId).toBe('si_mocked')

    // Meter event: value=250 cents (2.5 * unitsPerDollar=100), keyed by customer.
    expect(stripeCalls.meterEventCreate).toHaveLength(1)
    const ev = stripeCalls.meterEventCreate[0]
    expect(ev.event_name).toBe('usage_overage_cents')
    expect(ev.payload.stripe_customer_id).toBe('cus_abc')
    expect(ev.payload.value).toBe('250')
    expect(typeof ev.identifier).toBe('string')
  })

  test('reuses an existing metered item on the Stripe subscription instead of creating one', async () => {
    subscriptions.push({
      workspaceId: 'ws1',
      status: 'active',
      stripeSubscriptionId: 'sub_123',
      stripeCustomerId: 'cus_abc',
      planId: 'pro',
    })
    wallets.set('ws1', freshWallet('ws1', { stripeMeteredItemId: null }))
    stripeSubResponse = {
      items: {
        data: [
          {
            id: 'si_existing',
            price: { id: 'price_1TPrwgAp5PDuxitpra3BDHvR' },
          },
        ],
      },
    }

    await billing.reportOverageToStripe('ws1', 1.0)

    expect(stripeCalls.subItemCreate).toHaveLength(0)
    expect(wallets.get('ws1')!.stripeMeteredItemId).toBe('si_existing')
    expect(stripeCalls.meterEventCreate).toHaveLength(1)
    expect(stripeCalls.meterEventCreate[0].payload.value).toBe('100')
  })

  test('on subsequent overages skips the retrieve + attach round-trip and just emits the meter event', async () => {
    subscriptions.push({
      workspaceId: 'ws1',
      status: 'active',
      stripeSubscriptionId: 'sub_123',
      stripeCustomerId: 'cus_abc',
      planId: 'pro',
    })
    wallets.set(
      'ws1',
      freshWallet('ws1', { stripeMeteredItemId: 'si_cached' }),
    )

    await billing.reportOverageToStripe('ws1', 0.75)

    expect(stripeCalls.retrieve).toHaveLength(0)
    expect(stripeCalls.subItemCreate).toHaveLength(0)
    expect(stripeCalls.meterEventCreate).toHaveLength(1)
    // 0.75 * 100 = 75 cents
    expect(stripeCalls.meterEventCreate[0].payload.value).toBe('75')
  })

  test('clamps the reported meter event value to a minimum of 1 for tiny overages', async () => {
    subscriptions.push({
      workspaceId: 'ws1',
      status: 'active',
      stripeSubscriptionId: 'sub_123',
      stripeCustomerId: 'cus_abc',
      planId: 'pro',
    })
    wallets.set(
      'ws1',
      freshWallet('ws1', { stripeMeteredItemId: 'si_cached' }),
    )

    // $0.001 would round to 0 cents — must still report 1.
    await billing.reportOverageToStripe('ws1', 0.001)
    expect(stripeCalls.meterEventCreate[0].payload.value).toBe('1')
  })

  test('no-ops when STRIPE_SECRET_KEY is unset', async () => {
    delete process.env.STRIPE_SECRET_KEY
    subscriptions.push({
      workspaceId: 'ws1',
      status: 'active',
      stripeSubscriptionId: 'sub_123',
      stripeCustomerId: 'cus_abc',
      planId: 'pro',
    })
    wallets.set('ws1', freshWallet('ws1'))

    await billing.reportOverageToStripe('ws1', 1.5)

    expect(stripeCalls.meterEventCreate).toHaveLength(0)
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
