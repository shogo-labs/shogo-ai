// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `billing.service.ts` — broad coverage of pure logic, Prisma-backed query
 * paths, and Stripe-mediated workflows.
 *
 *   bun test apps/api/src/__tests__/billing-service.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

delete process.env.SHOGO_LOCAL_MODE
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'

// ────────────────────────────────────────────────────────────────────
// In-memory Prisma mock
// ────────────────────────────────────────────────────────────────────
let walletByWs = new Map<string, any>()
let subsByWs = new Map<string, any[]>()
let grantsByWs = new Map<string, any[]>()
let membersByWs = new Map<string, any[]>()
let usageEvents: any[] = []
let billingAccountsByWs = new Map<string, any>()

// Hooks let individual tests inject behavior (errors, etc.)
let walletUpdateHook: ((args: any) => any) | null = null
let walletCreateHook: ((args: any) => any) | null = null
let usageEventCreateHook: ((args: any) => any) | null = null

const walletStore = {
  findUnique: async (args: any) => walletByWs.get(args.where.workspaceId) ?? null,
  create: async (args: any) => {
    if (walletCreateHook) return walletCreateHook(args)
    walletByWs.set(args.data.workspaceId, { ...args.data })
    return walletByWs.get(args.data.workspaceId)
  },
  upsert: async (args: any) => {
    const ws = args.where.workspaceId
    const existing = walletByWs.get(ws)
    if (existing) {
      const merged = { ...existing, ...args.update }
      walletByWs.set(ws, merged)
      return merged
    }
    walletByWs.set(ws, { ...args.create })
    return walletByWs.get(ws)
  },
  update: async (args: any) => {
    if (walletUpdateHook) return walletUpdateHook(args)
    const ws = args.where.workspaceId
    const existing = walletByWs.get(ws) ?? {}
    const next: any = { ...existing }
    for (const [k, v] of Object.entries(args.data)) {
      if (v && typeof v === 'object' && 'increment' in (v as any)) {
        next[k] = (next[k] ?? 0) + (v as any).increment
      } else {
        next[k] = v
      }
    }
    walletByWs.set(ws, next)
    return next
  },
  updateMany: async (args: any) => {
    const ws = args.where.workspaceId
    const existing = walletByWs.get(ws)
    if (!existing) return { count: 0 }
    walletByWs.set(ws, { ...existing, ...args.data })
    return { count: 1 }
  },
}

const subscriptionStore = {
  findFirst: async (args: any) => {
    const subs = subsByWs.get(args.where.workspaceId) ?? []
    const statusIn: string[] | undefined = args.where.status?.in
    const filtered = statusIn ? subs.filter((s: any) => statusIn.includes(s.status)) : subs
    return filtered[0] ?? null
  },
  findMany: async (args: any) => subsByWs.get(args.where.workspaceId) ?? [],
  update: async (args: any) => {
    for (const [ws, subs] of subsByWs.entries()) {
      const idx = subs.findIndex((s: any) => s.id === args.where.id)
      if (idx >= 0) {
        subs[idx] = { ...subs[idx], ...args.data }
        return subs[idx]
      }
    }
    throw new Error(`subscription ${args.where.id} not found`)
  },
  upsert: async (args: any) => {
    const ws = args.where.workspaceId
    const existing = (subsByWs.get(ws) ?? [])[0]
    if (existing) {
      const merged = { ...existing, ...args.update }
      subsByWs.set(ws, [merged])
      return merged
    }
    const created = { id: `s-${ws}`, ...args.create }
    subsByWs.set(ws, [created])
    return created
  },
}

const mockPrisma: any = {
  subscription: subscriptionStore,
  usageWallet: walletStore,
  workspaceGrant: {
    findMany: async (args: any) => grantsByWs.get(args.where.workspaceId) ?? [],
  },
  usageEvent: {
    create: async (args: any) => {
      if (usageEventCreateHook) return usageEventCreateHook(args)
      const row = { id: `ue-${usageEvents.length + 1}`, ...args.data }
      usageEvents.push(row)
      return row
    },
    findMany: async (args: any) => {
      let rows = usageEvents.filter((e) => e.workspaceId === args.where.workspaceId)
      if (args.where.projectId) rows = rows.filter((e) => e.projectId === args.where.projectId)
      if (args.where.memberId) rows = rows.filter((e) => e.memberId === args.where.memberId)
      return rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 100))
    },
  },
  member: {
    findMany: async (args: any) => {
      const all = membersByWs.get(args.where.workspaceId) ?? []
      return all.filter((m: any) => (args.where.projectId === null ? m.projectId == null : true))
    },
  },
  billingAccount: {
    findUnique: async (args: any) => billingAccountsByWs.get(args.where.workspaceId) ?? null,
    upsert: async (args: any) => {
      const ws = args.where.workspaceId
      const existing = billingAccountsByWs.get(ws)
      if (existing) {
        const merged = { ...existing, ...args.update }
        billingAccountsByWs.set(ws, merged)
        return merged
      }
      const created = { workspaceId: ws, ...args.create }
      billingAccountsByWs.set(ws, created)
      return created
    },
  },
  $transaction: async (fn: (tx: any) => any) => fn(mockPrisma),
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

mock.module('../config/usage-plans', () => ({
  FREE_DAILY_INCLUDED_USD: 1,
  MONTHLY_DAILY_CAP_USD: 30,
  PLAN_INCLUDED_USD: { free: 0, basic: 5, pro: 20, business: 40 },
  PLAN_RANK: { free: 0, basic: 1, pro: 2, business: 3, enterprise: 4 },
  getDailyIncludedForPlan: (planId: string | null | undefined) => {
    if (!planId) return 1
    const lc = String(planId).toLowerCase().trim()
    if (lc.startsWith('free')) return 1
    if (
      lc.startsWith('basic') ||
      lc.startsWith('pro') ||
      lc.startsWith('business') ||
      lc.startsWith('enterprise')
    ) {
      return 0
    }
    return 1
  },
  getMonthlyIncludedForPlan: (plan: string, seats: number) => {
    if (plan === 'basic') return 5
    if (plan === 'pro') return 20 * seats
    if (plan === 'business') return 40 * seats
    if (plan === 'enterprise') return 2000 * seats
    return 0
  },
  normalizePlanId: (planId: string | null | undefined) => {
    if (!planId) return null
    const lc = String(planId).toLowerCase().trim()
    if (lc.startsWith('enterprise')) return 'enterprise'
    if (lc.startsWith('business')) return 'business'
    if (lc.startsWith('pro')) return 'pro'
    if (lc.startsWith('basic')) return 'basic'
    if (lc.startsWith('free')) return 'free'
    return null
  },
  comparePlanRank: (a: string | null | undefined, b: string | null | undefined) => {
    const rank: Record<string, number> = { free: 0, basic: 1, pro: 2, business: 3, enterprise: 4 }
    const norm = (v: string | null | undefined) => {
      if (!v) return 'free'
      const lc = String(v).toLowerCase().trim()
      if (lc.startsWith('enterprise')) return 'enterprise'
      if (lc.startsWith('business')) return 'business'
      if (lc.startsWith('pro')) return 'pro'
      if (lc.startsWith('basic')) return 'basic'
      return 'free'
    }
    return (rank[norm(a)] ?? 0) - (rank[norm(b)] ?? 0)
  },
}))

mock.module('../config/stripe-prices', () => ({
  getOveragePriceConfig: () => ({ priceId: 'price_overage_metered' }),
}))

// ────────────────────────────────────────────────────────────────────
// Stripe mock — capture every call so we can assert on idempotency keys
// and payload shape.
// ────────────────────────────────────────────────────────────────────
type StripeCall = { method: string; args: any[] }
const stripeCalls: StripeCall[] = []
let stripeSubRetrieveImpl: ((id: string) => any) | null = null
let stripeInvoicesPayImpl: ((id: string) => any) | null = null
let stripeInvoiceItemsCreateImpl: ((args: any) => any) | null = null

class FakeStripe {
  constructor(public key: string, public opts?: any) {}
  subscriptions = {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'subscriptions.retrieve', args: [id] })
      return stripeSubRetrieveImpl
        ? stripeSubRetrieveImpl(id)
        : { id, items: { data: [{ id: 'si_1', price: { id: 'price_seat', recurring: { usage_type: 'licensed' } } }] } }
    },
  }
  subscriptionItems = {
    update: async (...args: any[]) => {
      stripeCalls.push({ method: 'subscriptionItems.update', args })
      return { id: args[0], quantity: args[1]?.quantity }
    },
  }
  invoiceItems = {
    create: async (...args: any[]) => {
      stripeCalls.push({ method: 'invoiceItems.create', args })
      if (stripeInvoiceItemsCreateImpl) return stripeInvoiceItemsCreateImpl(args)
      return { id: 'ii_1' }
    },
  }
  invoices = {
    create: async (...args: any[]) => {
      stripeCalls.push({ method: 'invoices.create', args })
      return { id: 'in_1' }
    },
    finalizeInvoice: async (id: string) => {
      stripeCalls.push({ method: 'invoices.finalizeInvoice', args: [id] })
      return { id }
    },
    pay: async (id: string) => {
      stripeCalls.push({ method: 'invoices.pay', args: [id] })
      if (stripeInvoicesPayImpl) return stripeInvoicesPayImpl(id)
      return { id }
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe }))

const billing = await import('../services/billing.service')

beforeEach(() => {
  walletByWs.clear()
  subsByWs.clear()
  grantsByWs.clear()
  membersByWs.clear()
  billingAccountsByWs.clear()
  usageEvents = []
  stripeCalls.length = 0
  walletUpdateHook = null
  walletCreateHook = null
  usageEventCreateHook = null
  stripeSubRetrieveImpl = null
  stripeInvoicesPayImpl = null
  stripeInvoiceItemsCreateImpl = null
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
})

// Helper to build a wallet row in the store.
function seedWallet(ws: string, overrides: Partial<any> = {}) {
  const now = new Date()
  walletByWs.set(ws, {
    workspaceId: ws,
    monthlyIncludedUsd: 0,
    monthlyIncludedAllocationUsd: 0,
    dailyIncludedUsd: 1,
    dailyUsedThisMonthUsd: 0,
    overageAccumulatedUsd: 0,
    overageBilledUsd: 0,
    overageEnabled: false,
    overageHardLimitUsd: null,
    anniversaryDay: now.getDate(),
    lastDailyReset: now,
    lastMonthlyReset: now,
    ...overrides,
  })
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('nextOverageBlockUsd', () => {
  test('returns the trust-first ladder up to the cap', () => {
    expect(billing.nextOverageBlockUsd(0)).toBe(100)
    expect(billing.nextOverageBlockUsd(100)).toBe(200)
    expect(billing.nextOverageBlockUsd(300)).toBe(300)
    expect(billing.nextOverageBlockUsd(600)).toBe(400)
    expect(billing.nextOverageBlockUsd(1000)).toBe(500)
    expect(billing.nextOverageBlockUsd(1500)).toBe(500)
    expect(billing.nextOverageBlockUsd(10_000)).toBe(500)
  })

  test('negative input clamps to zero so the ladder starts at $100', () => {
    expect(billing.nextOverageBlockUsd(-50)).toBe(100)
  })
})

describe('getSubscription / getSubscriptions / getUsageWallet', () => {
  test('returns null when there is no subscription', async () => {
    expect(await billing.getSubscription('ws-1')).toBeNull()
  })

  test('returns the most recent subscription when present', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'pro' }])
    const sub = await billing.getSubscription('ws-1')
    expect(sub?.id).toBe('s-1')
  })

  test('getSubscriptions returns every row', async () => {
    subsByWs.set('ws-1', [{ id: 's-1' }, { id: 's-2' }])
    expect(await billing.getSubscriptions('ws-1')).toHaveLength(2)
  })

  test('getUsageWallet returns wallet when present and null otherwise', async () => {
    expect(await billing.getUsageWallet('ws-1')).toBeNull()
    seedWallet('ws-1', { monthlyIncludedUsd: 5 })
    const w = await billing.getUsageWallet('ws-1')
    expect(w?.monthlyIncludedUsd).toBe(5)
  })
})

describe('getActiveGrantsForWorkspace', () => {
  test('sums freeSeats and monthlyIncludedUsd across rows', async () => {
    grantsByWs.set('ws-1', [
      { freeSeats: 1, monthlyIncludedUsd: 10 },
      { freeSeats: 2, monthlyIncludedUsd: 5 },
    ])
    const g = await billing.getActiveGrantsForWorkspace('ws-1')
    expect(g.freeSeats).toBe(3)
    expect(g.monthlyIncludedUsd).toBe(15)
    expect(g.planId).toBeNull()
    expect(g.rowCount).toBe(2)
  })

  test('returns zero when there are no grants', async () => {
    const g = await billing.getActiveGrantsForWorkspace('ws-none')
    expect(g.freeSeats).toBe(0)
    expect(g.monthlyIncludedUsd).toBe(0)
    expect(g.planId).toBeNull()
    expect(g.rowCount).toBe(0)
  })

  test('picks the highest-tier planId across stacked grants', async () => {
    grantsByWs.set('ws-1', [
      { freeSeats: 0, monthlyIncludedUsd: 0, planId: 'pro' },
      { freeSeats: 0, monthlyIncludedUsd: 0, planId: 'business' },
      { freeSeats: 0, monthlyIncludedUsd: 0, planId: null },
    ])
    const g = await billing.getActiveGrantsForWorkspace('ws-1')
    expect(g.planId).toBe('business')
  })
})

describe('allocateFreeWallet', () => {
  test('creates a fresh wallet on first call', async () => {
    const wallet = await billing.allocateFreeWallet('ws-1')
    expect(wallet.workspaceId).toBe('ws-1')
    expect(wallet.dailyIncludedUsd).toBe(1)
    expect(wallet.monthlyIncludedUsd).toBe(0)
  })

  test('returns the existing wallet without re-creating it', async () => {
    const first = await billing.allocateFreeWallet('ws-1')
    const second = await billing.allocateFreeWallet('ws-1')
    expect(second).toBe(first)
  })

  test('stacks grant-supplied monthly USD on top of plan-included USD', async () => {
    grantsByWs.set('ws-1', [
      { freeSeats: 0, monthlyIncludedUsd: 50 },
      { freeSeats: 0, monthlyIncludedUsd: 25 },
    ])
    const wallet = await billing.allocateFreeWallet('ws-1')
    expect(wallet.monthlyIncludedUsd).toBe(75)
    expect(wallet.monthlyIncludedAllocationUsd).toBe(75)
  })
})

describe('applyGrantMonthlyAllocation', () => {
  test('upserts a wallet with the active grant USD', async () => {
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 100, planId: null }])
    const wallet = await billing.applyGrantMonthlyAllocation('ws-1')
    expect(wallet.monthlyIncludedUsd).toBe(100)
    // Credit-only grant on a free workspace doesn't flip overage on.
    expect(wallet.overageEnabled).toBe(false)
  })

  test('resets daily / overage counters when refreshing an existing wallet', async () => {
    seedWallet('ws-1', {
      dailyUsedThisMonthUsd: 7, overageAccumulatedUsd: 99, overageBilledUsd: 100,
    })
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 25, planId: null }])
    const wallet = await billing.applyGrantMonthlyAllocation('ws-1')
    expect(wallet.monthlyIncludedUsd).toBe(25)
    expect(wallet.dailyUsedThisMonthUsd).toBe(0)
    expect(wallet.overageAccumulatedUsd).toBe(0)
    expect(wallet.overageBilledUsd).toBe(0)
  })

  test('grant-conferred Pro plan allocates per-seat USD + flips overage on', async () => {
    grantsByWs.set('ws-1', [
      { freeSeats: 3, monthlyIncludedUsd: 10, planId: 'pro' },
    ])
    const wallet = await billing.applyGrantMonthlyAllocation('ws-1')
    // 3 seats * $20 (Pro per-seat) + $10 stacked credits.
    expect(wallet.monthlyIncludedUsd).toBe(70)
    expect(wallet.overageEnabled).toBe(true)
  })

  test('grant-conferred Business plan with zero freeSeats still gets 1 seat of USD', async () => {
    grantsByWs.set('ws-1', [
      { freeSeats: 0, monthlyIncludedUsd: 0, planId: 'business' },
    ])
    const wallet = await billing.applyGrantMonthlyAllocation('ws-1')
    expect(wallet.monthlyIncludedUsd).toBe(40)
    expect(wallet.overageEnabled).toBe(true)
  })
})

describe('allocateMonthlyIncluded', () => {
  test('grants `seats * plan-included` USD plus any active grant for paid plans', async () => {
    grantsByWs.set('ws-1', [{ freeSeats: 1, monthlyIncludedUsd: 10 }])
    const wallet = await billing.allocateMonthlyIncluded('ws-1', 'pro', 3)
    expect(wallet.monthlyIncludedUsd).toBe(90)
    expect(wallet.overageEnabled).toBe(true)
  })

  test('updates an existing wallet, resetting overage accumulators', async () => {
    seedWallet('ws-1', { overageAccumulatedUsd: 20, overageBilledUsd: 100, overageEnabled: false })
    const wallet = await billing.allocateMonthlyIncluded('ws-1', 'business', 2)
    expect(wallet.monthlyIncludedUsd).toBe(80)
    expect(wallet.overageEnabled).toBe(true)
    expect(wallet.overageAccumulatedUsd).toBe(0)
    expect(wallet.overageBilledUsd).toBe(0)
  })

  test('defaults to seats=1 with no grant', async () => {
    const wallet = await billing.allocateMonthlyIncluded('ws-1', 'basic')
    expect(wallet.monthlyIncludedUsd).toBe(5)
  })

  test('clamps non-positive seats and floats to a sane integer count', async () => {
    const wallet = await billing.allocateMonthlyIncluded('ws-1', 'pro', 0 as any)
    expect(wallet.monthlyIncludedUsd).toBe(20)
  })
})

describe('hasPaidSubscription / hasAdvancedModelAccess / isBusinessOrHigherPlan', () => {
  test('returns false when no subscription exists', async () => {
    expect(await billing.hasPaidSubscription('ws-1')).toBe(false)
    expect(await billing.hasAdvancedModelAccess('ws-1')).toBe(false)
    expect(await billing.isBusinessOrHigherPlan('ws-1')).toBe(false)
  })

  test('returns true for an active Pro subscription', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'pro' }])
    expect(await billing.hasPaidSubscription('ws-1')).toBe(true)
    expect(await billing.hasAdvancedModelAccess('ws-1')).toBe(true)
    expect(await billing.isBusinessOrHigherPlan('ws-1')).toBe(false)
  })

  test('returns true for an active Business subscription', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'trialing', planId: 'business-month' }])
    expect(await billing.hasPaidSubscription('ws-1')).toBe(true)
    expect(await billing.hasAdvancedModelAccess('ws-1')).toBe(true)
    expect(await billing.isBusinessOrHigherPlan('ws-1')).toBe(true)
  })

  test('returns false for a Basic plan via hasAdvancedModelAccess', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'basic' }])
    expect(await billing.hasAdvancedModelAccess('ws-1')).toBe(false)
  })

  test('Enterprise plan ID is treated as business-or-higher', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'Enterprise-Annual' }])
    expect(await billing.isBusinessOrHigherPlan('ws-1')).toBe(true)
  })

  test('grant-conferred Pro lifts a workspace with no subscription to advanced access', async () => {
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 0, planId: 'pro' }])
    expect(await billing.hasPaidSubscription('ws-1')).toBe(true)
    expect(await billing.hasAdvancedModelAccess('ws-1')).toBe(true)
    expect(await billing.isBusinessOrHigherPlan('ws-1')).toBe(false)
  })

  test('grant-conferred Business lifts a workspace with no subscription to business+', async () => {
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 0, planId: 'business' }])
    expect(await billing.isBusinessOrHigherPlan('ws-1')).toBe(true)
  })

  test('credit-only grant (no planId) does not change plan tier', async () => {
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 500, planId: null }])
    expect(await billing.hasPaidSubscription('ws-1')).toBe(false)
    expect(await billing.hasAdvancedModelAccess('ws-1')).toBe(false)
  })

  test('paid subscription wins over a grant-conferred plan', async () => {
    // Subscription is Basic; grant says Business. Sub wins → not advanced.
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'basic' }])
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 0, planId: 'business' }])
    expect(await billing.hasAdvancedModelAccess('ws-1')).toBe(false)
    expect(await billing.isBusinessOrHigherPlan('ws-1')).toBe(false)
  })
})

describe('getEffectivePlanId', () => {
  test("falls back to 'free' when no sub and no grant", async () => {
    expect(await billing.getEffectivePlanId('ws-1')).toBe('free')
  })

  test('returns the subscription plan when present (ignores grant)', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'Business-Annual' }])
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 0, planId: 'enterprise' }])
    expect(await billing.getEffectivePlanId('ws-1')).toBe('business')
  })

  test('returns the grant planId when there is no subscription', async () => {
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 0, planId: 'pro' }])
    expect(await billing.getEffectivePlanId('ws-1')).toBe('pro')
  })
})

describe('hasBalance', () => {
  test('returns true when the workspace has included USD covering the request', async () => {
    seedWallet('ws-1', { monthlyIncludedUsd: 5, monthlyIncludedAllocationUsd: 5 })
    expect(await billing.hasBalance('ws-1', 0.001)).toBe(true)
  })

  test('returns false when included is exhausted and overage is disabled', async () => {
    seedWallet('ws-1', { dailyIncludedUsd: 0, dailyUsedThisMonthUsd: 30 })
    expect(await billing.hasBalance('ws-1', 10)).toBe(false)
  })

  test('allows overage spending under the hard cap', async () => {
    seedWallet('ws-1', {
      dailyIncludedUsd: 0, dailyUsedThisMonthUsd: 30, overageAccumulatedUsd: 5,
      overageEnabled: true, overageHardLimitUsd: 50,
    })
    expect(await billing.hasBalance('ws-1', 20)).toBe(true)
  })

  test('blocks spending past the hard cap even with overage on', async () => {
    seedWallet('ws-1', {
      dailyIncludedUsd: 0, dailyUsedThisMonthUsd: 30, overageAccumulatedUsd: 50,
      overageEnabled: true, overageHardLimitUsd: 50,
    })
    expect(await billing.hasBalance('ws-1', 1)).toBe(false)
  })

  test('returns true when overage hard limit is unset (unlimited)', async () => {
    seedWallet('ws-1', {
      dailyIncludedUsd: 0, dailyUsedThisMonthUsd: 30, overageAccumulatedUsd: 999,
      overageEnabled: true, overageHardLimitUsd: null,
    })
    expect(await billing.hasBalance('ws-1', 1000)).toBe(true)
  })

  test('allocates a free wallet if none exists', async () => {
    expect(walletByWs.has('ws-new')).toBe(false)
    const out = await billing.hasBalance('ws-new', 0.001)
    expect(walletByWs.has('ws-new')).toBe(true)
    expect(out).toBe(true)
  })

  test('lazy-resets daily on a new day before checking balance', async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000)
    seedWallet('ws-1', {
      dailyIncludedUsd: 0,
      dailyUsedThisMonthUsd: 5,
      lastDailyReset: yesterday,
      lastMonthlyReset: yesterday,
    })
    // Same month, dispensed 5 < cap 30 → daily refills to 1
    expect(await billing.hasBalance('ws-1', 0.5)).toBe(true)
  })

  test('does not refill daily when monthly cap has been hit', async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000)
    seedWallet('ws-1', {
      dailyIncludedUsd: 0,
      dailyUsedThisMonthUsd: 30, // at cap
      lastDailyReset: yesterday,
      lastMonthlyReset: yesterday,
    })
    expect(await billing.hasBalance('ws-1', 0.5)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────
// consumeUsage / _consumeUsageTransaction
// ────────────────────────────────────────────────────────────────────

describe('consumeUsage', () => {
  test('deducts from daily first when sufficient', async () => {
    seedWallet('ws-1', { dailyIncludedUsd: 1, monthlyIncludedUsd: 5 })
    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 0.5,
    })
    expect(res.success).toBe(true)
    expect(res.source).toBe('daily')
    expect(res.overageChargedUsd).toBe(0)
    expect(walletByWs.get('ws-1').dailyIncludedUsd).toBeCloseTo(0.5)
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].source).toBe('daily')
  })

  test('returns "No usage wallet found" when allocation fails and re-find still misses', async () => {
    // walletByWs starts empty so findUnique returns null. allocateFreeWallet
    // calls walletStore.create — make that throw so the catch swallows it,
    // leaving wallet null and falling through to the error return. Covers
    // the early-return path in _consumeUsageTransaction.
    walletCreateHook = () => { throw new Error('db offline') }
    const res = await billing.consumeUsage({
      workspaceId: 'ws-no-wallet', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 0.1,
    })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/No usage wallet found/i)
  })

  test('falls through to monthly when daily cannot cover', async () => {
    seedWallet('ws-1', { dailyIncludedUsd: 0.1, monthlyIncludedUsd: 5 })
    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 2,
    })
    expect(res.success).toBe(true)
    expect(res.source).toBe('monthly')
    expect(walletByWs.get('ws-1').monthlyIncludedUsd).toBe(3)
  })

  test('falls through to overage when neither bucket suffices and overage is enabled', async () => {
    seedWallet('ws-1', {
      dailyIncludedUsd: 0.1, monthlyIncludedUsd: 1,
      overageEnabled: true, overageHardLimitUsd: 1000,
    })
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', stripeCustomerId: 'cus_1' }])

    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 5,
    })
    expect(res.success).toBe(true)
    expect(res.source).toBe('overage')
    expect(res.overageChargedUsd).toBe(5)
    expect(walletByWs.get('ws-1').overageAccumulatedUsd).toBe(5)
    // chargeOverageBlocks is fired async; under $100 nothing posts to Stripe.
    await new Promise((r) => setTimeout(r, 10))
    expect(stripeCalls.find((c) => c.method === 'invoiceItems.create')).toBeUndefined()
  })

  test('fails when included exhausted, overage disabled', async () => {
    seedWallet('ws-1', { dailyIncludedUsd: 0, monthlyIncludedUsd: 0 })
    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 1,
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe('Usage limit reached')
  })

  test('fails when overage enabled but hard limit reached', async () => {
    seedWallet('ws-1', {
      dailyIncludedUsd: 0, monthlyIncludedUsd: 0,
      overageEnabled: true, overageHardLimitUsd: 10, overageAccumulatedUsd: 10,
    })
    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 5,
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe('Usage hard limit reached')
    expect(res.source).toBe('overage')
  })

  test('allocates a free wallet when missing and proceeds', async () => {
    const res = await billing.consumeUsage({
      workspaceId: 'ws-new', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 0.01,
    })
    expect(res.success).toBe(true)
    expect(walletByWs.has('ws-new')).toBe(true)
  })

  test('retries on FK constraint for projectId then succeeds', async () => {
    seedWallet('ws-1', { dailyIncludedUsd: 1 })
    let attempts = 0
    usageEventCreateHook = (args: any) => {
      attempts++
      if (attempts < 2) {
        const err: any = new Error('FK violation')
        err.code = 'P2003'
        err.meta = { field_name: 'usage_events_projectId_fkey' }
        throw err
      }
      return { id: 'ue-ok', ...args.data }
    }
    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: 'p-pending', memberId: 'm-1',
      actionType: 'chat', billedUsd: 0.1,
    })
    expect(res.success).toBe(true)
    expect(attempts).toBe(2)
  }, 10000)

  test('does not retry FK errors when projectId is null', async () => {
    seedWallet('ws-1', { dailyIncludedUsd: 1 })
    usageEventCreateHook = () => {
      const err: any = new Error('FK violation')
      err.code = 'P2003'
      err.meta = { field_name: 'usage_events_projectId_fkey' }
      throw err
    }
    await expect(
      billing.consumeUsage({
        workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
        actionType: 'chat', billedUsd: 0.1,
      }),
    ).rejects.toThrow('FK violation')
  })

  test('non-FK errors propagate without retry', async () => {
    seedWallet('ws-1', { dailyIncludedUsd: 1 })
    usageEventCreateHook = () => { throw new Error('boom') }
    await expect(
      billing.consumeUsage({
        workspaceId: 'ws-1', projectId: 'p-1', memberId: 'm-1',
        actionType: 'chat', billedUsd: 0.1,
      }),
    ).rejects.toThrow('boom')
  })

  test('daily reset on a new day re-dispenses included daily USD', async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000)
    seedWallet('ws-1', {
      dailyIncludedUsd: 0,
      dailyUsedThisMonthUsd: 5,
      lastDailyReset: yesterday,
      lastMonthlyReset: yesterday,
    })
    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 0.3,
    })
    expect(res.success).toBe(true)
    expect(res.source).toBe('daily')
    const w = walletByWs.get('ws-1')
    expect(w.dailyUsedThisMonthUsd).toBe(6) // 5 + 1 newly dispensed
  })

  test('daily reset honors the monthly daily-dispensing cap', async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000)
    seedWallet('ws-1', {
      dailyIncludedUsd: 0,
      dailyUsedThisMonthUsd: 30, // at cap
      lastDailyReset: yesterday,
      lastMonthlyReset: yesterday,
    })
    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 0.3,
    })
    expect(res.success).toBe(false)
  })

  test('monthly rollover refills free workspaces from grants', async () => {
    const lastMonth = new Date()
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 2)
    seedWallet('ws-1', {
      dailyIncludedUsd: 0,
      monthlyIncludedUsd: 0,
      dailyUsedThisMonthUsd: 10,
      overageAccumulatedUsd: 5,
      overageBilledUsd: 0,
      lastDailyReset: lastMonth,
      lastMonthlyReset: lastMonth,
    })
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 25 }])
    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 0.1,
    })
    expect(res.success).toBe(true)
    const w = walletByWs.get('ws-1')
    // Refill ran (25 grant) then deducted from daily ($1 dispensed)
    expect(w.monthlyIncludedAllocationUsd).toBe(25)
    expect(w.overageBilledUsd).toBe(0)
    expect(w.overageAccumulatedUsd).toBe(0)
  })

  test('monthly rollover skips grant refill for paid workspaces', async () => {
    const lastMonth = new Date()
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 2)
    seedWallet('ws-1', {
      monthlyIncludedUsd: 5,
      lastDailyReset: lastMonth,
      lastMonthlyReset: lastMonth,
    })
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'pro' }])
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 9999 }])
    const res = await billing.consumeUsage({
      workspaceId: 'ws-1', projectId: null, memberId: 'm-1',
      actionType: 'chat', billedUsd: 0.1,
    })
    expect(res.success).toBe(true)
    const w = walletByWs.get('ws-1')
    // Grant refill should NOT have applied (would have set monthly to 9999+);
    // monthly stays at the original 5 minus the 0.1 charge. The daily
    // allowance is free-tier only, so the cost falls through to monthly
    // for a Pro workspace.
    expect(w.monthlyIncludedUsd).toBeCloseTo(4.9, 6)
  })
})

describe('consumeCredits (legacy shim)', () => {
  test('converts credits to USD at $0.10/credit and proxies to consumeUsage', async () => {
    seedWallet('ws-1', { dailyIncludedUsd: 1 })
    const res = await billing.consumeCredits('ws-1', null, 'm-1', 'chat', 2)
    expect(res.success).toBe(true)
    expect(res.remainingCredits).toBeCloseTo((1 - 0.2) / 0.1) // remaining included divided
  })

  test('propagates failure shape', async () => {
    seedWallet('ws-1', { dailyIncludedUsd: 0, monthlyIncludedUsd: 0 })
    const res = await billing.consumeCredits('ws-1', null, 'm-1', 'chat', 10)
    expect(res.success).toBe(false)
    expect(res.error).toBeDefined()
  })
})

// ────────────────────────────────────────────────────────────────────
// chargeOverageBlocks
// ────────────────────────────────────────────────────────────────────

describe('chargeOverageBlocks', () => {
  test('no-op when STRIPE_SECRET_KEY missing', async () => {
    delete process.env.STRIPE_SECRET_KEY
    seedWallet('ws-1', { overageAccumulatedUsd: 200, overageBilledUsd: 0 })
    const n = await billing.chargeOverageBlocks('ws-1')
    expect(n).toBe(0)
  })

  test('no-op when wallet missing', async () => {
    const n = await billing.chargeOverageBlocks('ws-missing')
    expect(n).toBe(0)
  })

  test('no-op when unbilled overage is below the first block size', async () => {
    seedWallet('ws-1', { overageAccumulatedUsd: 50, overageBilledUsd: 0 })
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', stripeCustomerId: 'cus_1' }])
    const n = await billing.chargeOverageBlocks('ws-1')
    expect(n).toBe(0)
  })

  test('skips when no active Stripe customer found', async () => {
    seedWallet('ws-1', { overageAccumulatedUsd: 200, overageBilledUsd: 0 })
    const n = await billing.chargeOverageBlocks('ws-1')
    expect(n).toBe(0)
  })

  test('peels off a single $100 block when unbilled is between $100 and $200', async () => {
    seedWallet('ws-1', { overageAccumulatedUsd: 150, overageBilledUsd: 0 })
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', stripeCustomerId: 'cus_1' }])
    const n = await billing.chargeOverageBlocks('ws-1')
    expect(n).toBe(1)
    expect(stripeCalls.find((c) => c.method === 'invoiceItems.create')?.args[0].amount).toBe(100 * 100)
    expect(walletByWs.get('ws-1').overageBilledUsd).toBe(100)
  })

  test('bundles multiple ladder steps into one invoice', async () => {
    // First two ladder blocks: $100 + $200 = $300
    seedWallet('ws-1', { overageAccumulatedUsd: 350, overageBilledUsd: 0 })
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', stripeCustomerId: 'cus_1' }])
    const n = await billing.chargeOverageBlocks('ws-1')
    expect(n).toBe(2)
    const item = stripeCalls.find((c) => c.method === 'invoiceItems.create')!
    expect(item.args[0].amount).toBe(300 * 100)
    expect(item.args[0].metadata.blockSizes).toBe('100,200')
    expect(walletByWs.get('ws-1').overageBilledUsd).toBe(300)
  })

  test('swallows pay() errors but still increments overageBilledUsd', async () => {
    seedWallet('ws-1', { overageAccumulatedUsd: 120, overageBilledUsd: 0 })
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', stripeCustomerId: 'cus_1' }])
    stripeInvoicesPayImpl = () => { throw new Error('card_declined') }
    const n = await billing.chargeOverageBlocks('ws-1')
    expect(n).toBe(1)
    expect(walletByWs.get('ws-1').overageBilledUsd).toBe(100)
  })

  test('returns 0 and swallows when stripe.invoiceItems.create throws', async () => {
    seedWallet('ws-1', { overageAccumulatedUsd: 120, overageBilledUsd: 0 })
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', stripeCustomerId: 'cus_1' }])
    stripeInvoiceItemsCreateImpl = () => { throw new Error('stripe outage') }
    const n = await billing.chargeOverageBlocks('ws-1')
    expect(n).toBe(0)
    expect(walletByWs.get('ws-1').overageBilledUsd).toBe(0)
  })
})

describe('reportOverageToStripe (deprecated shim)', () => {
  test('delegates to chargeOverageBlocks', async () => {
    seedWallet('ws-1', { overageAccumulatedUsd: 150, overageBilledUsd: 0 })
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', stripeCustomerId: 'cus_1' }])
    await billing.reportOverageToStripe('ws-1', 25)
    expect(stripeCalls.find((c) => c.method === 'invoiceItems.create')).toBeTruthy()
  })
})

// ────────────────────────────────────────────────────────────────────
// syncFromStripe / getUsageEvents / billingAccount helpers
// ────────────────────────────────────────────────────────────────────

describe('syncFromStripe', () => {
  test('creates a new subscription row', async () => {
    const sub = await billing.syncFromStripe({
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_1',
      workspaceId: 'ws-1',
      planId: 'pro',
      seats: 3,
      status: 'active' as any,
      billingInterval: 'monthly' as any,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
    })
    expect(sub.workspaceId).toBe('ws-1')
    expect(sub.seats).toBe(3)
  })

  test('clamps seats to at least 1 and floors fractions', async () => {
    const sub = await billing.syncFromStripe({
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_1',
      workspaceId: 'ws-1',
      planId: 'basic',
      seats: 0 as any,
      status: 'active' as any,
      billingInterval: 'monthly' as any,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
    })
    expect(sub.seats).toBe(1)
  })

  test('updates an existing row by workspaceId', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', stripeSubscriptionId: 'sub_old', planId: 'basic', seats: 1, status: 'active', cancelAtPeriodEnd: false }])
    const sub = await billing.syncFromStripe({
      stripeSubscriptionId: 'sub_new',
      stripeCustomerId: 'cus_1',
      workspaceId: 'ws-1',
      planId: 'pro',
      seats: 2,
      status: 'active' as any,
      billingInterval: 'monthly' as any,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: true,
    })
    expect(sub.planId).toBe('pro')
    expect(sub.seats).toBe(2)
    expect(sub.cancelAtPeriodEnd).toBe(true)
  })
})

describe('getUsageEvents', () => {
  test('filters by projectId and memberId, respecting paging', async () => {
    usageEvents.push(
      { id: 'e1', workspaceId: 'ws-1', projectId: 'p1', memberId: 'm1' },
      { id: 'e2', workspaceId: 'ws-1', projectId: 'p2', memberId: 'm1' },
      { id: 'e3', workspaceId: 'ws-1', projectId: 'p1', memberId: 'm2' },
      { id: 'e4', workspaceId: 'ws-2', projectId: 'p1', memberId: 'm1' },
    )
    const all = await billing.getUsageEvents('ws-1')
    expect(all.length).toBe(3)
    const byProject = await billing.getUsageEvents('ws-1', { projectId: 'p1' })
    expect(byProject.length).toBe(2)
    const byMember = await billing.getUsageEvents('ws-1', { memberId: 'm1', limit: 1, offset: 1 })
    expect(byMember.length).toBe(1)
  })
})

describe('billingAccount helpers', () => {
  test('getBillingAccount returns null when missing', async () => {
    expect(await billing.getBillingAccount('ws-1')).toBeNull()
  })

  test('upsertBillingAccount creates then updates', async () => {
    const a = await billing.upsertBillingAccount('ws-1', { stripeCustomerId: 'cus_1', taxId: 'tax_1' })
    expect(a.stripeCustomerId).toBe('cus_1')
    const b = await billing.upsertBillingAccount('ws-1', { stripeCustomerId: 'cus_2' })
    expect(b.stripeCustomerId).toBe('cus_2')
  })
})

describe('countActiveWorkspaceMembers', () => {
  test('counts unique workspace-level (projectId=null) members, min 1', async () => {
    membersByWs.set('ws-1', [
      { userId: 'u1', projectId: null },
      { userId: 'u2', projectId: null },
      { userId: 'u1', projectId: null }, // duplicate userId
    ])
    expect(await billing.countActiveWorkspaceMembers('ws-1')).toBe(2)
  })

  test('returns 1 when there are no members (floor)', async () => {
    expect(await billing.countActiveWorkspaceMembers('ws-empty')).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────
// syncSeatsFromMembership
// ────────────────────────────────────────────────────────────────────

describe('syncSeatsFromMembership', () => {
  test('returns no_active_subscription when there is no sub', async () => {
    const r = await billing.syncSeatsFromMembership('ws-1')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_active_subscription')
  })

  test('returns basic_plan_single_seat for Basic plan', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'basic', seats: 1, stripeSubscriptionId: 'sub_1' }])
    const r = await billing.syncSeatsFromMembership('ws-1')
    expect(r.reason).toBe('basic_plan_single_seat')
  })

  test('when already in sync, just refreshes wallet allocation', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'pro', seats: 2, stripeSubscriptionId: 'sub_1' }])
    membersByWs.set('ws-1', [{ userId: 'u1', projectId: null }, { userId: 'u2', projectId: null }])
    seedWallet('ws-1', { monthlyIncludedUsd: 0 })
    const r = await billing.syncSeatsFromMembership('ws-1')
    expect(r.ok).toBe(true)
    expect(r.seats).toBe(2)
    expect(walletByWs.get('ws-1').monthlyIncludedUsd).toBe(40)
    expect(stripeCalls.find((c) => c.method === 'subscriptionItems.update')).toBeUndefined()
  })

  test('when key missing, updates local seats only', async () => {
    delete process.env.STRIPE_SECRET_KEY
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'pro', seats: 1, stripeSubscriptionId: 'sub_1' }])
    membersByWs.set('ws-1', [{ userId: 'u1', projectId: null }, { userId: 'u2', projectId: null }, { userId: 'u3', projectId: null }])
    seedWallet('ws-1', {})
    const r = await billing.syncSeatsFromMembership('ws-1')
    expect(r.ok).toBe(true)
    expect(r.seats).toBe(3)
    expect(r.reason).toBe('stripe_unconfigured')
    expect(subsByWs.get('ws-1')![0].seats).toBe(3)
    expect(walletByWs.get('ws-1').monthlyIncludedUsd).toBe(60)
  })

  test('updates Stripe and DB when seat count changed', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'pro', seats: 1, stripeSubscriptionId: 'sub_1' }])
    membersByWs.set('ws-1', [{ userId: 'u1', projectId: null }, { userId: 'u2', projectId: null }])
    seedWallet('ws-1', {})
    const r = await billing.syncSeatsFromMembership('ws-1')
    expect(r.ok).toBe(true)
    expect(r.seats).toBe(2)
    const upd = stripeCalls.find((c) => c.method === 'subscriptionItems.update')!
    expect(upd.args[1].quantity).toBe(2)
    expect(upd.args[1].proration_behavior).toBe('always_invoice')
    expect(subsByWs.get('ws-1')![0].seats).toBe(2)
  })

  test('returns no_seat_item when only the overage metered item exists', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'pro', seats: 1, stripeSubscriptionId: 'sub_1' }])
    membersByWs.set('ws-1', [{ userId: 'u1', projectId: null }, { userId: 'u2', projectId: null }])
    seedWallet('ws-1', {})
    stripeSubRetrieveImpl = () => ({
      id: 'sub_1',
      items: { data: [{ id: 'si_meter', price: { id: 'price_overage_metered', recurring: { usage_type: 'metered' } } }] },
    })
    const r = await billing.syncSeatsFromMembership('ws-1')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_seat_item')
  })

  test('errors are caught and reported', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'pro', seats: 1, stripeSubscriptionId: 'sub_1' }])
    membersByWs.set('ws-1', [{ userId: 'u1', projectId: null }, { userId: 'u2', projectId: null }])
    seedWallet('ws-1', {})
    stripeSubRetrieveImpl = () => { throw new Error('stripe down') }
    const r = await billing.syncSeatsFromMembership('ws-1')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('error')
  })

  test('clamps desiredStripeSeats to 1 when grant freeSeats exceeds member count', async () => {
    subsByWs.set('ws-1', [{ id: 's-1', workspaceId: 'ws-1', status: 'active', planId: 'pro', seats: 1, stripeSubscriptionId: 'sub_1' }])
    membersByWs.set('ws-1', [{ userId: 'u1', projectId: null }])
    grantsByWs.set('ws-1', [{ freeSeats: 5, monthlyIncludedUsd: 0 }])
    seedWallet('ws-1', {})
    const r = await billing.syncSeatsFromMembership('ws-1')
    expect(r.ok).toBe(true)
    expect(r.seats).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────
// setUsageBasedPricing
// ────────────────────────────────────────────────────────────────────

describe('setUsageBasedPricing', () => {
  test('creates a wallet when missing, applying overage settings', async () => {
    const w = await billing.setUsageBasedPricing('ws-1', { overageEnabled: true, overageHardLimitUsd: 250 })
    expect(w.overageEnabled).toBe(true)
    expect(w.overageHardLimitUsd).toBe(250)
  })

  test('updates an existing wallet without clobbering monthly USD', async () => {
    seedWallet('ws-1', { monthlyIncludedUsd: 20 })
    const w = await billing.setUsageBasedPricing('ws-1', { overageEnabled: false })
    expect(w.overageEnabled).toBe(false)
    expect(w.overageHardLimitUsd).toBeNull()
    expect(w.monthlyIncludedUsd).toBe(20)
  })
})
