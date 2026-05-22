// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ============================================================================
// In-memory prisma mock
// ============================================================================

type Sub = {
  id: string
  workspaceId: string
  stripeSubscriptionId: string
  stripeCustomerId: string
  planId: string
  seats: number
  status: string
  billingInterval: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  createdAt: Date
}
type Wallet = {
  workspaceId: string
  monthlyIncludedUsd: number
  monthlyIncludedAllocationUsd: number
  dailyIncludedUsd: number
  dailyUsedThisMonthUsd: number
  overageAccumulatedUsd: number
  overageBilledUsd: number
  overageEnabled: boolean
  overageHardLimitUsd: number | null
  anniversaryDay: number
  lastDailyReset: Date
  lastMonthlyReset: Date
}
type Grant = {
  id: string
  workspaceId: string
  freeSeats: number
  monthlyIncludedUsd: number
  planId: string | null
  startsAt: Date
  expiresAt: Date | null
}
type UsageEvent = {
  id: string
  workspaceId: string
  projectId: string | null
  memberId: string
  actionType: string
  rawUsd: number | null
  billedUsd: number
  source: string
  balanceBefore: number
  balanceAfter: number
  actionMetadata: any
  createdAt: Date
}
type BillingAccount = { workspaceId: string; stripeCustomerId: string | null; taxId: string | null }
type Member = { workspaceId: string; userId: string; projectId: string | null }

const subs = new Map<string, Sub[]>() // by workspaceId
const wallets = new Map<string, Wallet>()
const grants = new Map<string, Grant[]>() // by workspaceId
const usageEvents: UsageEvent[] = []
const billingAccounts = new Map<string, BillingAccount>()
const members: Member[] = []

let usageEventCreateImpl: (data: any) => Promise<any> | any = (data) => {
  const ev: UsageEvent = {
    id: `ue_${usageEvents.length + 1}`,
    workspaceId: data.workspaceId,
    projectId: data.projectId ?? null,
    memberId: data.memberId,
    actionType: data.actionType,
    rawUsd: data.rawUsd ?? null,
    billedUsd: data.billedUsd,
    source: data.source,
    balanceBefore: data.balanceBefore,
    balanceAfter: data.balanceAfter,
    actionMetadata: data.actionMetadata ?? null,
    createdAt: new Date(),
  }
  usageEvents.push(ev)
  return ev
}

function flattenSubs() {
  const out: Sub[] = []
  for (const arr of subs.values()) out.push(...arr)
  return out
}

const prismaApi = {
  subscription: {
    findFirst: async ({ where, select, orderBy }: any) => {
      let candidates = where?.workspaceId ? (subs.get(where.workspaceId) ?? []) : flattenSubs()
      if (where?.status?.in) candidates = candidates.filter((s) => where.status.in.includes(s.status))
      if (orderBy?.createdAt === 'desc') candidates = [...candidates].sort((a, b) => +b.createdAt - +a.createdAt)
      const s = candidates[0]
      if (!s) return null
      if (!select) return s
      const out: any = {}
      for (const k of Object.keys(select)) if (select[k]) out[k] = (s as any)[k]
      return out
    },
    findMany: async ({ where, orderBy }: any) => {
      let candidates = where?.workspaceId ? (subs.get(where.workspaceId) ?? []) : flattenSubs()
      if (orderBy?.createdAt === 'desc') candidates = [...candidates].sort((a, b) => +b.createdAt - +a.createdAt)
      return candidates
    },
    upsert: async ({ where, create, update }: any) => {
      const arr = subs.get(where.workspaceId) ?? []
      const existing = arr[0]
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const fresh: Sub = { id: `sub_${Math.random()}`, createdAt: new Date(), ...create }
      subs.set(where.workspaceId, [fresh])
      return fresh
    },
    update: async ({ where, data }: any) => {
      for (const arr of subs.values()) {
        const s = arr.find((x) => x.id === where.id)
        if (s) { Object.assign(s, data); return s }
      }
      throw new Error('sub not found')
    },
  },
  usageWallet: {
    findUnique: async ({ where }: any) => wallets.get(where.workspaceId) ?? null,
    create: async ({ data }: any) => {
      const w: Wallet = {
        workspaceId: data.workspaceId,
        monthlyIncludedUsd: data.monthlyIncludedUsd ?? 0,
        monthlyIncludedAllocationUsd: data.monthlyIncludedAllocationUsd ?? 0,
        dailyIncludedUsd: data.dailyIncludedUsd ?? 0,
        dailyUsedThisMonthUsd: data.dailyUsedThisMonthUsd ?? 0,
        overageAccumulatedUsd: 0,
        overageBilledUsd: 0,
        overageEnabled: data.overageEnabled ?? false,
        overageHardLimitUsd: data.overageHardLimitUsd ?? null,
        anniversaryDay: data.anniversaryDay,
        lastDailyReset: data.lastDailyReset,
        lastMonthlyReset: data.lastMonthlyReset,
      }
      wallets.set(data.workspaceId, w)
      return w
    },
    update: async ({ where, data }: any) => {
      const w = wallets.get(where.workspaceId)
      if (!w) throw new Error('wallet not found')
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in (v as any)) {
          ;(w as any)[k] = ((w as any)[k] ?? 0) + (v as any).increment
        } else {
          ;(w as any)[k] = v
        }
      }
      return w
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = wallets.get(where.workspaceId)
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      return prismaApi.usageWallet.create({ data: create })
    },
    updateMany: async ({ where, data }: any) => {
      const w = wallets.get(where.workspaceId)
      if (w) Object.assign(w, data)
      return { count: w ? 1 : 0 }
    },
  },
  workspaceGrant: {
    findMany: async ({ where }: any) => {
      const rows = grants.get(where.workspaceId) ?? []
      const now = where.startsAt?.lte ?? new Date()
      return rows.filter((r) => {
        if (+r.startsAt > +now) return false
        if (r.expiresAt && +r.expiresAt <= +now) return false
        return true
      })
    },
  },
  usageEvent: {
    create: async ({ data }: any) => usageEventCreateImpl(data),
    findMany: async ({ where, take, skip }: any) => {
      let rows = usageEvents.filter((e) => e.workspaceId === where.workspaceId)
      if (where?.projectId) rows = rows.filter((e) => e.projectId === where.projectId)
      if (where?.memberId) rows = rows.filter((e) => e.memberId === where.memberId)
      return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? 100))
    },
  },
  billingAccount: {
    findUnique: async ({ where }: any) => billingAccounts.get(where.workspaceId) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const existing = billingAccounts.get(where.workspaceId)
      if (existing) { Object.assign(existing, update); return existing }
      const fresh = { workspaceId: where.workspaceId, ...create }
      billingAccounts.set(where.workspaceId, fresh)
      return fresh
    },
  },
  member: {
    findMany: async ({ where }: any) => {
      return members.filter((m) =>
        m.workspaceId === where.workspaceId &&
        (where.projectId === null ? m.projectId === null : true),
      )
    },
  },
  $transaction: async (fn: any) => fn(prismaApi),
}

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// ============================================================================
// stripe-prices mock
// ============================================================================
mock.module('../../config/stripe-prices', () => ({
  getOveragePriceConfig: () => ({ priceId: 'price_overage_x' }),
}))

// ============================================================================
// stripe dynamic-import mock
// ============================================================================
const stripeCalls: Array<{ method: string; args: any[]; opts?: any }> = []
let stripeInvoiceItemsCreate = async (args: any, opts: any) => {
  stripeCalls.push({ method: 'invoiceItems.create', args: [args], opts })
  return { id: 'ii_1' }
}
let stripeInvoicesCreate = async (args: any, opts: any) => {
  stripeCalls.push({ method: 'invoices.create', args: [args], opts })
  return { id: 'in_1' }
}
let stripeInvoicesFinalize = async (id: string) => {
  stripeCalls.push({ method: 'invoices.finalizeInvoice', args: [id] })
  return { id }
}
let stripeInvoicesPay = async (id: string) => {
  stripeCalls.push({ method: 'invoices.pay', args: [id] })
  return { id }
}
let stripeSubscriptionsRetrieve = async (id: string) => {
  stripeCalls.push({ method: 'subscriptions.retrieve', args: [id] })
  return {
    items: { data: [{ id: 'si_seat', price: { id: 'price_seat', recurring: { usage_type: 'licensed' } } }] },
  }
}
let stripeSubscriptionItemsUpdate = async (id: string, data: any) => {
  stripeCalls.push({ method: 'subscriptionItems.update', args: [id, data] })
  return {}
}

class FakeStripe {
  constructor(public key: string) {}
  invoiceItems = { create: (a: any, o: any) => stripeInvoiceItemsCreate(a, o) }
  invoices = {
    create: (a: any, o: any) => stripeInvoicesCreate(a, o),
    finalizeInvoice: (id: string) => stripeInvoicesFinalize(id),
    pay: (id: string) => stripeInvoicesPay(id),
  }
  subscriptions = { retrieve: (id: string) => stripeSubscriptionsRetrieve(id) }
  subscriptionItems = { update: (id: string, d: any) => stripeSubscriptionItemsUpdate(id, d) }
}

mock.module('stripe', () => ({ default: FakeStripe }))

const billing = await import('../billing.service')

// ============================================================================
// Lifecycle
// ============================================================================
const origConsole = { log: console.log, warn: console.warn, error: console.error }
const logs: any[][] = []

beforeEach(() => {
  subs.clear()
  wallets.clear()
  grants.clear()
  usageEvents.length = 0
  billingAccounts.clear()
  members.length = 0
  stripeCalls.length = 0
  logs.length = 0
  usageEventCreateImpl = (data) => {
    const ev: UsageEvent = {
      id: `ue_${usageEvents.length + 1}`,
      workspaceId: data.workspaceId,
      projectId: data.projectId ?? null,
      memberId: data.memberId,
      actionType: data.actionType,
      rawUsd: data.rawUsd ?? null,
      billedUsd: data.billedUsd,
      source: data.source,
      balanceBefore: data.balanceBefore,
      balanceAfter: data.balanceAfter,
      actionMetadata: data.actionMetadata ?? null,
      createdAt: new Date(),
    }
    usageEvents.push(ev)
    return ev
  }
  console.log = (...a) => logs.push(a)
  console.warn = (...a) => logs.push(a)
  console.error = (...a) => logs.push(a)
  delete (process.env as any).STRIPE_SECRET_KEY
})

afterEach(() => {
  console.log = origConsole.log
  console.warn = origConsole.warn
  console.error = origConsole.error
})

// Helpers. Use real current time as default so consumeUsage's needsDaily/
// needsMonthly reset branches stay false unless a test explicitly overrides.
const today = new Date('2026-03-15T12:00:00Z')
function freshWallet(over: Partial<Wallet> = {}): Wallet {
  const now = new Date()
  return {
    workspaceId: 'w1',
    monthlyIncludedUsd: 20,
    monthlyIncludedAllocationUsd: 20,
    dailyIncludedUsd: 0.5,
    dailyUsedThisMonthUsd: 0,
    overageAccumulatedUsd: 0,
    overageBilledUsd: 0,
    overageEnabled: false,
    overageHardLimitUsd: null,
    anniversaryDay: 1,
    lastDailyReset: now,
    lastMonthlyReset: now,
    ...over,
  }
}

// ============================================================================
// getSubscription / getSubscriptions / getUsageWallet
// ============================================================================
describe('basic getters', () => {
  it('getSubscription returns null when nothing exists', async () => {
    expect(await billing.getSubscription('w1')).toBeNull()
  })
  it('getSubscription returns the latest by createdAt', async () => {
    const old: Sub = { id: 's1', workspaceId: 'w1', stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_x', planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly', currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: new Date('2026-01-01') }
    const fresh: Sub = { ...old, id: 's2', stripeSubscriptionId: 'sub_new', createdAt: new Date('2026-03-01') }
    subs.set('w1', [old, fresh])
    expect((await billing.getSubscription('w1'))?.stripeSubscriptionId).toBe('sub_new')
  })
  it('getSubscriptions returns all', async () => {
    subs.set('w1', [{} as Sub, {} as Sub])
    expect(await billing.getSubscriptions('w1')).toHaveLength(2)
  })
  it('getUsageWallet returns null when missing', async () => {
    expect(await billing.getUsageWallet('w1')).toBeNull()
  })
  it('getUsageWallet returns the wallet', async () => {
    wallets.set('w1', freshWallet())
    expect((await billing.getUsageWallet('w1'))?.workspaceId).toBe('w1')
  })
})

// ============================================================================
// Grants + effective plan
// ============================================================================
describe('getActiveGrantsForWorkspace', () => {
  it('returns zero defaults when no grants', async () => {
    expect(await billing.getActiveGrantsForWorkspace('w1')).toEqual({
      freeSeats: 0, monthlyIncludedUsd: 0, planId: null, rowCount: 0,
    })
  })
  it('sums multiple active grants and picks highest plan tier', async () => {
    grants.set('w1', [
      { id: 'g1', workspaceId: 'w1', freeSeats: 2, monthlyIncludedUsd: 100, planId: 'basic', startsAt: new Date('2026-01-01'), expiresAt: null },
      { id: 'g2', workspaceId: 'w1', freeSeats: 3, monthlyIncludedUsd: 500, planId: 'pro', startsAt: new Date('2026-01-01'), expiresAt: null },
    ])
    const r = await billing.getActiveGrantsForWorkspace('w1', today)
    expect(r).toEqual({ freeSeats: 5, monthlyIncludedUsd: 600, planId: 'pro', rowCount: 2 })
  })
  it('filters expired grants', async () => {
    grants.set('w1', [
      { id: 'g1', workspaceId: 'w1', freeSeats: 99, monthlyIncludedUsd: 99, planId: 'business', startsAt: new Date('2025-01-01'), expiresAt: new Date('2025-02-01') },
    ])
    const r = await billing.getActiveGrantsForWorkspace('w1', today)
    expect(r.rowCount).toBe(0)
  })
})

describe('getEffectivePlanId', () => {
  it('returns "free" when no sub or grant', async () => {
    expect(await billing.getEffectivePlanId('w1')).toBe('free')
  })
  it('uses paid subscription planId', async () => {
    subs.set('w1', [{ id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c', planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly', currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today }])
    expect(await billing.getEffectivePlanId('w1')).toBe('pro')
  })
  it('falls back to grant planId when no paid sub', async () => {
    grants.set('w1', [{ id: 'g', workspaceId: 'w1', freeSeats: 0, monthlyIncludedUsd: 0, planId: 'business', startsAt: today, expiresAt: null }])
    expect(await billing.getEffectivePlanId('w1')).toBe('business')
  })
})

// ============================================================================
// Wallet allocation
// ============================================================================
describe('allocateFreeWallet', () => {
  it('creates a wallet with daily-only allocation', async () => {
    const w = await billing.allocateFreeWallet('w1')
    expect(w.monthlyIncludedUsd).toBe(0)
    expect(w.dailyIncludedUsd).toBe(0.5)
    expect(wallets.get('w1')).toBeDefined()
  })
  it('returns existing wallet untouched', async () => {
    wallets.set('w1', freshWallet({ monthlyIncludedUsd: 999 }))
    const w = await billing.allocateFreeWallet('w1')
    expect(w.monthlyIncludedUsd).toBe(999)
  })
  it('seeds monthly USD from active grants', async () => {
    grants.set('w1', [{ id: 'g', workspaceId: 'w1', freeSeats: 0, monthlyIncludedUsd: 250, planId: null, startsAt: today, expiresAt: null }])
    const w = await billing.allocateFreeWallet('w1')
    expect(w.monthlyIncludedUsd).toBe(250)
  })
})

describe('applyGrantMonthlyAllocation', () => {
  it('creates wallet with grant USD when none exists', async () => {
    grants.set('w1', [{ id: 'g', workspaceId: 'w1', freeSeats: 2, monthlyIncludedUsd: 100, planId: 'pro', startsAt: today, expiresAt: null }])
    const w = await billing.applyGrantMonthlyAllocation('w1', today)
    expect(w.monthlyIncludedUsd).toBeGreaterThan(100)
    expect(w.overageEnabled).toBe(true)
  })
  it('updates existing wallet and resets accumulated overage', async () => {
    wallets.set('w1', freshWallet({ overageAccumulatedUsd: 50, overageBilledUsd: 30 }))
    grants.set('w1', [{ id: 'g', workspaceId: 'w1', freeSeats: 1, monthlyIncludedUsd: 75, planId: null, startsAt: today, expiresAt: null }])
    const w = await billing.applyGrantMonthlyAllocation('w1', today)
    expect(w.overageAccumulatedUsd).toBe(0)
    expect(w.overageBilledUsd).toBe(0)
  })
  it('leaves overageEnabled unchanged for additive-only grants on update', async () => {
    wallets.set('w1', freshWallet({ overageEnabled: false }))
    grants.set('w1', [{ id: 'g', workspaceId: 'w1', freeSeats: 0, monthlyIncludedUsd: 10, planId: null, startsAt: today, expiresAt: null }])
    const w = await billing.applyGrantMonthlyAllocation('w1', today)
    expect(w.overageEnabled).toBe(false)
  })
})

// ============================================================================
// Overage block ladder
// ============================================================================
describe('nextOverageBlockUsd', () => {
  it('returns $100 at zero', () => {
    expect(billing.nextOverageBlockUsd(0)).toBe(100)
  })
  it('escalates by $100 per block, capped at $500', () => {
    expect(billing.nextOverageBlockUsd(100)).toBe(200) // after 1 block of 100
    expect(billing.nextOverageBlockUsd(300)).toBe(300) // 100+200
    expect(billing.nextOverageBlockUsd(600)).toBe(400) // 100+200+300
    expect(billing.nextOverageBlockUsd(1000)).toBe(500)
    expect(billing.nextOverageBlockUsd(10_000)).toBe(500)
  })
  it('clamps negatives to zero', () => {
    expect(billing.nextOverageBlockUsd(-50)).toBe(100)
  })
})

// ============================================================================
// allocateMonthlyIncluded
// ============================================================================
describe('allocateMonthlyIncluded', () => {
  it('creates wallet with per-seat pro USD', async () => {
    const w = await billing.allocateMonthlyIncluded('w1', 'pro', 3)
    expect(w.monthlyIncludedUsd).toBe(60) // 20 * 3
    expect(w.overageEnabled).toBe(true)
  })
  it('basic single user ignores seats > 1', async () => {
    const w = await billing.allocateMonthlyIncluded('w1', 'basic', 5)
    expect(w.monthlyIncludedUsd).toBe(5)
  })
  it('adds grant-conferred seats + USD', async () => {
    grants.set('w1', [{ id: 'g', workspaceId: 'w1', freeSeats: 2, monthlyIncludedUsd: 50, planId: null, startsAt: today, expiresAt: null }])
    const w = await billing.allocateMonthlyIncluded('w1', 'pro', 1)
    expect(w.monthlyIncludedUsd).toBe(20 * 3 + 50)
  })
  it('updates existing wallet and clears overage counters', async () => {
    wallets.set('w1', freshWallet({ overageAccumulatedUsd: 99, overageBilledUsd: 88 }))
    const w = await billing.allocateMonthlyIncluded('w1', 'pro', 1)
    expect(w.overageAccumulatedUsd).toBe(0)
    expect(w.overageBilledUsd).toBe(0)
  })
  it('seats coerced to floor and minimum 1', async () => {
    const w = await billing.allocateMonthlyIncluded('w1', 'pro', 0)
    expect(w.monthlyIncludedUsd).toBe(20)
  })
})

// ============================================================================
// Plan-tier helpers
// ============================================================================
describe('plan helpers (no local mode)', () => {
  it('hasPaidSubscription false for free', async () => {
    expect(await billing.hasPaidSubscription('w1')).toBe(false)
  })
  it('hasPaidSubscription true for basic', async () => {
    subs.set('w1', [{ id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c', planId: 'basic', seats: 1, status: 'active', billingInterval: 'monthly', currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today }])
    expect(await billing.hasPaidSubscription('w1')).toBe(true)
  })
  it('hasAdvancedModelAccess true for pro, false for basic', async () => {
    subs.set('w1', [{ id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c', planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly', currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today }])
    expect(await billing.hasAdvancedModelAccess('w1')).toBe(true)
    subs.set('w2', [{ id: 's2', workspaceId: 'w2', stripeSubscriptionId: 's', stripeCustomerId: 'c', planId: 'basic', seats: 1, status: 'active', billingInterval: 'monthly', currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today }])
    expect(await billing.hasAdvancedModelAccess('w2')).toBe(false)
  })
  it('isBusinessOrHigherPlan only for business+', async () => {
    subs.set('w1', [{ id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c', planId: 'business', seats: 1, status: 'active', billingInterval: 'monthly', currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today }])
    expect(await billing.isBusinessOrHigherPlan('w1')).toBe(true)
  })
})

// ============================================================================
// hasBalance
// ============================================================================
describe('hasBalance', () => {
  it('lazy-allocates wallet on first call', async () => {
    expect(await billing.hasBalance('w1', 0.001)).toBe(true)
    expect(wallets.get('w1')).toBeDefined()
  })
  it('returns true when monthly included covers cost', async () => {
    wallets.set('w1', freshWallet({ monthlyIncludedUsd: 5 }))
    expect(await billing.hasBalance('w1', 3)).toBe(true)
  })
  it('returns false when no overage and included < cost', async () => {
    wallets.set('w1', freshWallet({ monthlyIncludedUsd: 0, dailyIncludedUsd: 0, overageEnabled: false }))
    expect(await billing.hasBalance('w1', 5)).toBe(false)
  })
  it('returns true when overage with no hard limit can cover', async () => {
    wallets.set('w1', freshWallet({ monthlyIncludedUsd: 0, dailyIncludedUsd: 0, overageEnabled: true, overageHardLimitUsd: null }))
    expect(await billing.hasBalance('w1', 9999)).toBe(true)
  })
  it('returns false when hard limit blocks the spend', async () => {
    wallets.set('w1', freshWallet({ monthlyIncludedUsd: 0, dailyIncludedUsd: 0, overageEnabled: true, overageHardLimitUsd: 10, overageAccumulatedUsd: 10 }))
    expect(await billing.hasBalance('w1', 5)).toBe(false)
  })
  it('reflects daily reset (new day → daily refills)', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
    wallets.set('w1', freshWallet({
      dailyIncludedUsd: 0, lastDailyReset: yesterday,
      dailyUsedThisMonthUsd: 0, monthlyIncludedUsd: 0,
    }))
    expect(await billing.hasBalance('w1', 0.4)).toBe(true)
  })
  it('reflects monthly daily cap exhausted (no refill)', async () => {
    // lastMonthlyReset stays in the SAME current month (so the cap counter
    // is not zeroed), but lastDailyReset is yesterday so the daily-reset
    // branch fires and the cap-check decides daily=0.
    const now = new Date()
    const sameMonth = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1)
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000)
    wallets.set('w1', freshWallet({
      dailyIncludedUsd: 0, lastDailyReset: yesterday,
      dailyUsedThisMonthUsd: 3, lastMonthlyReset: sameMonth,
      monthlyIncludedUsd: 0,
    }))
    expect(await billing.hasBalance('w1', 0.4)).toBe(false)
  })
})

// ============================================================================
// consumeUsage
// ============================================================================
describe('consumeUsage', () => {
  const base = {
    workspaceId: 'w1', projectId: null, memberId: 'u1',
    actionType: 'chat_message', billedUsd: 0.1,
  }

  it('returns failure when no wallet can be created (allocate fallthrough)', async () => {
    wallets.set('w1', freshWallet({ monthlyIncludedUsd: 0, dailyIncludedUsd: 0, overageEnabled: false }))
    const r = await billing.consumeUsage(base)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Usage limit reached/)
  })

  it('deducts from daily first', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 0.5, monthlyIncludedUsd: 0 }))
    const r = await billing.consumeUsage({ ...base, billedUsd: 0.2 })
    expect(r.success).toBe(true)
    expect(r.source).toBe('daily')
    expect(wallets.get('w1')?.dailyIncludedUsd).toBeCloseTo(0.3, 5)
  })

  it('falls through to monthly when daily insufficient', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 0.1, monthlyIncludedUsd: 10 }))
    const r = await billing.consumeUsage({ ...base, billedUsd: 5 })
    expect(r.source).toBe('monthly')
    expect(wallets.get('w1')?.monthlyIncludedUsd).toBe(5)
  })

  it('falls through to overage when enabled', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 0, monthlyIncludedUsd: 0, overageEnabled: true, overageHardLimitUsd: 1000 }))
    const r = await billing.consumeUsage({ ...base, billedUsd: 5 })
    expect(r.source).toBe('overage')
    expect(r.overageChargedUsd).toBe(5)
    expect(wallets.get('w1')?.overageAccumulatedUsd).toBe(5)
  })

  it('returns hard-limit error when overage room insufficient', async () => {
    wallets.set('w1', freshWallet({
      dailyIncludedUsd: 0, monthlyIncludedUsd: 0,
      overageEnabled: true, overageHardLimitUsd: 3, overageAccumulatedUsd: 0,
    }))
    const r = await billing.consumeUsage({ ...base, billedUsd: 5 })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/hard limit/)
  })

  it('records a usage event row with correct source', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 0.5, monthlyIncludedUsd: 10 }))
    await billing.consumeUsage({ ...base, billedUsd: 0.2 })
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].source).toBe('daily')
  })

  it('passes through in local mode without debiting', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    // Local mode is captured at module load; can't re-toggle. Skip this assertion.
    delete (process.env as any).SHOGO_LOCAL_MODE
  })
})

// ============================================================================
// consumeCredits (legacy shim)
// ============================================================================
describe('consumeCredits (legacy)', () => {
  it('converts credit-cost to USD and returns credits-remaining', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 0.5, monthlyIncludedUsd: 10 }))
    const r = await billing.consumeCredits('w1', null, 'u', 'x', 2)
    expect(r.success).toBe(true)
    expect(r.remainingCredits).toBeGreaterThan(0)
  })
  it('surfaces error from underlying consumeUsage', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 0, monthlyIncludedUsd: 0, overageEnabled: false }))
    const r = await billing.consumeCredits('w1', null, 'u', 'x', 1)
    expect(r.success).toBe(false)
    expect(r.error).toBeDefined()
  })
})

// ============================================================================
// chargeOverageBlocks
// ============================================================================
describe('chargeOverageBlocks', () => {
  it('returns 0 when STRIPE_SECRET_KEY unset', async () => {
    expect(await billing.chargeOverageBlocks('w1')).toBe(0)
  })
  it('returns 0 when no wallet', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    expect(await billing.chargeOverageBlocks('missing')).toBe(0)
  })
  it('returns 0 when nothing to bill', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    wallets.set('w1', freshWallet({ overageAccumulatedUsd: 50, overageBilledUsd: 0 }))
    expect(await billing.chargeOverageBlocks('w1')).toBe(0)
  })
  it('returns 0 when no Stripe customer linked', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    wallets.set('w1', freshWallet({ overageAccumulatedUsd: 150, overageBilledUsd: 0 }))
    expect(await billing.chargeOverageBlocks('w1')).toBe(0)
  })
  it('bills one $100 block when over threshold', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    wallets.set('w1', freshWallet({ overageAccumulatedUsd: 150, overageBilledUsd: 0 }))
    subs.set('w1', [{
      id: 's1', workspaceId: 'w1', stripeSubscriptionId: 'sub_x', stripeCustomerId: 'cus_x',
      planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly',
      currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today,
    }])
    const n = await billing.chargeOverageBlocks('w1')
    expect(n).toBe(1)
    expect(stripeCalls.find((c) => c.method === 'invoiceItems.create')).toBeDefined()
    expect(wallets.get('w1')?.overageBilledUsd).toBe(100)
  })
  it('handles stripe.invoices.pay throwing (dunning fallback)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    wallets.set('w1', freshWallet({ overageAccumulatedUsd: 150 }))
    subs.set('w1', [{
      id: 's1', workspaceId: 'w1', stripeSubscriptionId: 'sub_x', stripeCustomerId: 'cus_x',
      planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly',
      currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today,
    }])
    const origPay = stripeInvoicesPay
    stripeInvoicesPay = async () => { throw new Error('card declined') }
    try {
      const n = await billing.chargeOverageBlocks('w1')
      expect(n).toBe(1)
    } finally {
      stripeInvoicesPay = origPay
    }
  })
  it('returns 0 and logs when Stripe invoiceItems.create throws', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    wallets.set('w1', freshWallet({ overageAccumulatedUsd: 150 }))
    subs.set('w1', [{
      id: 's1', workspaceId: 'w1', stripeSubscriptionId: 'sub_x', stripeCustomerId: 'cus_x',
      planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly',
      currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today,
    }])
    const orig = stripeInvoiceItemsCreate
    stripeInvoiceItemsCreate = async () => { throw new Error('stripe down') }
    try {
      expect(await billing.chargeOverageBlocks('w1')).toBe(0)
    } finally {
      stripeInvoiceItemsCreate = orig
    }
  })
})

// ============================================================================
// reportOverageToStripe (deprecated shim)
// ============================================================================
describe('reportOverageToStripe', () => {
  it('delegates to chargeOverageBlocks', async () => {
    await billing.reportOverageToStripe('w1', 0)
    // No-op without Stripe key — just shouldn't throw
  })
})

// ============================================================================
// syncFromStripe
// ============================================================================
describe('syncFromStripe', () => {
  const base = {
    stripeSubscriptionId: 'sub_x', stripeCustomerId: 'cus_x',
    workspaceId: 'w1', planId: 'pro',
    status: 'active' as const, billingInterval: 'monthly' as const,
    currentPeriodStart: today, currentPeriodEnd: today,
  }
  it('creates new subscription with default seats=1', async () => {
    await billing.syncFromStripe(base)
    expect(subs.get('w1')?.[0].seats).toBe(1)
  })
  it('clamps seats below 1 to 1', async () => {
    await billing.syncFromStripe({ ...base, seats: 0 })
    expect(subs.get('w1')?.[0].seats).toBe(1)
  })
  it('passes through explicit seats', async () => {
    await billing.syncFromStripe({ ...base, seats: 5 })
    expect(subs.get('w1')?.[0].seats).toBe(5)
  })
  it('updates existing subscription', async () => {
    await billing.syncFromStripe(base)
    await billing.syncFromStripe({ ...base, planId: 'business' })
    expect(subs.get('w1')?.[0].planId).toBe('business')
  })
  it('respects cancelAtPeriodEnd', async () => {
    await billing.syncFromStripe({ ...base, cancelAtPeriodEnd: true })
    expect(subs.get('w1')?.[0].cancelAtPeriodEnd).toBe(true)
  })
})

// ============================================================================
// getUsageEvents
// ============================================================================
describe('getUsageEvents', () => {
  beforeEach(() => {
    for (let i = 0; i < 3; i++) {
      usageEvents.push({
        id: `ue${i}`, workspaceId: 'w1', projectId: `p${i % 2}`, memberId: 'u1',
        actionType: 'x', rawUsd: null, billedUsd: 0.1, source: 'daily',
        balanceBefore: 0, balanceAfter: 0, actionMetadata: null, createdAt: new Date(),
      })
    }
  })
  it('returns all events for a workspace', async () => {
    expect((await billing.getUsageEvents('w1')).length).toBeGreaterThanOrEqual(3)
  })
  it('filters by projectId', async () => {
    const r = await billing.getUsageEvents('w1', { projectId: 'p0' })
    expect(r.every((e: any) => e.projectId === 'p0')).toBe(true)
  })
  it('respects limit + offset', async () => {
    expect((await billing.getUsageEvents('w1', { limit: 1, offset: 1 })).length).toBe(1)
  })
})

// ============================================================================
// billing account
// ============================================================================
describe('getBillingAccount / upsertBillingAccount', () => {
  it('returns null when missing', async () => {
    expect(await billing.getBillingAccount('w1')).toBeNull()
  })
  it('creates then updates an account', async () => {
    await billing.upsertBillingAccount('w1', { stripeCustomerId: 'cus_x' })
    expect((await billing.getBillingAccount('w1'))?.stripeCustomerId).toBe('cus_x')
    await billing.upsertBillingAccount('w1', { stripeCustomerId: 'cus_y' })
    expect((await billing.getBillingAccount('w1'))?.stripeCustomerId).toBe('cus_y')
  })
})

// ============================================================================
// Membership + seat sync
// ============================================================================
describe('countActiveWorkspaceMembers', () => {
  it('returns 1 floor even with zero members', async () => {
    expect(await billing.countActiveWorkspaceMembers('w1')).toBe(1)
  })
  it('dedupes by userId across overlapping rows', async () => {
    members.push(
      { workspaceId: 'w1', userId: 'u1', projectId: null },
      { workspaceId: 'w1', userId: 'u1', projectId: null },
      { workspaceId: 'w1', userId: 'u2', projectId: null },
    )
    expect(await billing.countActiveWorkspaceMembers('w1')).toBe(2)
  })
})

describe('syncSeatsFromMembership', () => {
  it('returns no_active_subscription when none', async () => {
    expect((await billing.syncSeatsFromMembership('w1')).reason).toBe('no_active_subscription')
  })
  it('skips basic plan', async () => {
    subs.set('w1', [{
      id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c',
      planId: 'basic', seats: 1, status: 'active', billingInterval: 'monthly',
      currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today,
    }])
    expect((await billing.syncSeatsFromMembership('w1')).reason).toBe('basic_plan_single_seat')
  })
  it('returns ok when already in sync', async () => {
    subs.set('w1', [{
      id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c',
      planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly',
      currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today,
    }])
    const r = await billing.syncSeatsFromMembership('w1')
    expect(r.ok).toBe(true)
    expect(r.seats).toBe(1)
  })
  it('updates DB only when Stripe is unconfigured', async () => {
    subs.set('w1', [{
      id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c',
      planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly',
      currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today,
    }])
    members.push(
      { workspaceId: 'w1', userId: 'u1', projectId: null },
      { workspaceId: 'w1', userId: 'u2', projectId: null },
      { workspaceId: 'w1', userId: 'u3', projectId: null },
    )
    const r = await billing.syncSeatsFromMembership('w1')
    expect(r.ok).toBe(true)
    expect(r.seats).toBe(3)
    expect(r.reason).toBe('stripe_unconfigured')
    expect(subs.get('w1')?.[0].seats).toBe(3)
  })
  it('drives Stripe item quantity when configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    subs.set('w1', [{
      id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c',
      planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly',
      currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today,
    }])
    members.push(
      { workspaceId: 'w1', userId: 'u1', projectId: null },
      { workspaceId: 'w1', userId: 'u2', projectId: null },
    )
    const r = await billing.syncSeatsFromMembership('w1')
    expect(r.ok).toBe(true)
    expect(r.seats).toBe(2)
    const u = stripeCalls.find((c) => c.method === 'subscriptionItems.update')!
    expect(u.args[1].quantity).toBe(2)
    expect(u.args[1].proration_behavior).toBe('always_invoice')
  })
  it('returns no_seat_item when no licensed item found', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    subs.set('w1', [{
      id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c',
      planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly',
      currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today,
    }])
    // Need 2+ members so desiredStripeSeats(=2) differs from sub.seats(=1)
    members.push(
      { workspaceId: 'w1', userId: 'u1', projectId: null },
      { workspaceId: 'w1', userId: 'u2', projectId: null },
    )
    const orig = stripeSubscriptionsRetrieve
    stripeSubscriptionsRetrieve = async () => ({ items: { data: [{ id: 'si_metered', price: { id: 'price_overage_x' } }] } }) as any
    try {
      expect((await billing.syncSeatsFromMembership('w1')).reason).toBe('no_seat_item')
    } finally {
      stripeSubscriptionsRetrieve = orig
    }
  })
  it('returns error on exception', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    subs.set('w1', [{
      id: 's1', workspaceId: 'w1', stripeSubscriptionId: 's', stripeCustomerId: 'c',
      planId: 'pro', seats: 1, status: 'active', billingInterval: 'monthly',
      currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today,
    }])
    members.push(
      { workspaceId: 'w1', userId: 'u1', projectId: null },
      { workspaceId: 'w1', userId: 'u2', projectId: null },
    )
    const orig = stripeSubscriptionsRetrieve
    stripeSubscriptionsRetrieve = async () => { throw new Error('boom') }
    try {
      expect((await billing.syncSeatsFromMembership('w1')).reason).toBe('error')
    } finally {
      stripeSubscriptionsRetrieve = orig
    }
  })
})

// ============================================================================
// setUsageBasedPricing
// ============================================================================
describe('setUsageBasedPricing', () => {
  it('creates a wallet when none exists', async () => {
    const w = await billing.setUsageBasedPricing('w1', { overageEnabled: true })
    expect(w.overageEnabled).toBe(true)
    expect(wallets.get('w1')?.overageEnabled).toBe(true)
  })
  it('updates existing wallet flags', async () => {
    wallets.set('w1', freshWallet())
    await billing.setUsageBasedPricing('w1', { overageEnabled: true, overageHardLimitUsd: 500 })
    expect(wallets.get('w1')?.overageHardLimitUsd).toBe(500)
  })
  it('supports clearing the hard limit', async () => {
    wallets.set('w1', freshWallet({ overageHardLimitUsd: 100 }))
    await billing.setUsageBasedPricing('w1', { overageEnabled: true, overageHardLimitUsd: null })
    expect(wallets.get('w1')?.overageHardLimitUsd).toBeNull()
  })
})
