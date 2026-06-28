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
  fiveHourWindowStart: Date | null
  fiveHourUsedUsd: number
  weeklyWindowStart: Date | null
  weeklyUsedUsd: number
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
const workspaces = new Map<string, { id: string; name: string; slug: string; parentWorkspaceId?: string | null }>()

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
        fiveHourWindowStart: data.fiveHourWindowStart ?? null,
        fiveHourUsedUsd: data.fiveHourUsedUsd ?? 0,
        weeklyWindowStart: data.weeklyWindowStart ?? null,
        weeklyUsedUsd: data.weeklyUsedUsd ?? 0,
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
      return members.filter((m) => {
        const wsMatch = where.workspaceId?.in
          ? where.workspaceId.in.includes(m.workspaceId)
          : m.workspaceId === where.workspaceId
        const projMatch = where.projectId === null ? m.projectId === null : true
        return wsMatch && projMatch
      })
    },
  },
  workspace: {
    findUnique: async ({ where }: any) => workspaces.get(where.id) ?? null,
    findMany: async ({ where }: any) => {
      let rows = Array.from(workspaces.values())
      if (where?.parentWorkspaceId !== undefined) {
        rows = rows.filter((w: any) => (w.parentWorkspaceId ?? null) === where.parentWorkspaceId)
      }
      return rows
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = workspaces.get(where.id)
      if (existing) { Object.assign(existing, update); return existing }
      const fresh = { id: where.id, ...create }
      workspaces.set(where.id, fresh)
      return fresh
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
  workspaces.clear()
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
    fiveHourWindowStart: null,
    fiveHourUsedUsd: 0,
    weeklyWindowStart: null,
    weeklyUsedUsd: 0,
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
    expect(w.dailyIncludedUsd).toBe(1)
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
  it('canPublishSubdomain false for free and basic', async () => {
    expect(await billing.canPublishSubdomain('w1')).toBe(false)
    subs.set('w2', [{ id: 's2', workspaceId: 'w2', stripeSubscriptionId: 's', stripeCustomerId: 'c', planId: 'basic', seats: 1, status: 'active', billingInterval: 'monthly', currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today }])
    expect(await billing.canPublishSubdomain('w2')).toBe(false)
  })
  it('canPublishSubdomain true for pro, business, enterprise', async () => {
    for (const [ws, plan] of [['wp', 'pro'], ['wb', 'business'], ['we', 'enterprise']] as const) {
      subs.set(ws, [{ id: `s_${ws}`, workspaceId: ws, stripeSubscriptionId: 's', stripeCustomerId: 'c', planId: plan, seats: 1, status: 'active', billingInterval: 'monthly', currentPeriodStart: today, currentPeriodEnd: today, cancelAtPeriodEnd: false, createdAt: today }])
      expect(await billing.canPublishSubdomain(ws)).toBe(true)
    }
  })
})

// ============================================================================
// hasBalance
// ============================================================================
// Build a Sub row with the minimum fields resolveWorkspaceWindowLimits reads
// (planId + seats), so tests can pin a workspace to a specific plan tier.
function setPlan(planId: string, seats = 1, workspaceId = 'w1') {
  const s: Sub = {
    id: `sub_${planId}`, workspaceId, stripeSubscriptionId: `stripe_${planId}`,
    stripeCustomerId: 'cus_x', planId, seats, status: 'active',
    billingInterval: 'monthly', currentPeriodStart: today, currentPeriodEnd: today,
    cancelAtPeriodEnd: false, createdAt: today,
  }
  subs.set(workspaceId, [s])
}

const now0 = () => new Date()

describe('hasBalance (rolling windows)', () => {
  it('lazy-allocates wallet on first call; free window has room', async () => {
    expect(await billing.hasBalance('w1', 0.01)).toBe(true)
    expect(wallets.get('w1')).toBeDefined()
  })
  it('returns true when a window still has room (pro plan)', async () => {
    setPlan('pro') // 5h=1.6, weekly=4
    wallets.set('w1', freshWallet())
    expect(await billing.hasBalance('w1', 0.5)).toBe(true)
  })
  it('returns false when both windows exhausted and no overage (free)', async () => {
    wallets.set('w1', freshWallet({
      overageEnabled: false,
      fiveHourWindowStart: now0(), fiveHourUsedUsd: 0.5, // over free 5h cap = 0.2
      weeklyWindowStart: now0(), weeklyUsedUsd: 2,         // over free weekly cap = 0.5
    }))
    expect(await billing.hasBalance('w1', 0.4)).toBe(false)
  })
  it('returns true via overage when window exhausted and overage uncapped', async () => {
    wallets.set('w1', freshWallet({
      overageEnabled: true, overageHardLimitUsd: null,
      fiveHourWindowStart: now0(), fiveHourUsedUsd: 0.5,
      weeklyWindowStart: now0(), weeklyUsedUsd: 2,
    }))
    expect(await billing.hasBalance('w1', 9999)).toBe(true)
  })
  it('returns false when window exhausted and overage hard limit blocks', async () => {
    wallets.set('w1', freshWallet({
      overageEnabled: true, overageHardLimitUsd: 10, overageAccumulatedUsd: 10,
      fiveHourWindowStart: now0(), fiveHourUsedUsd: 0.5,
      weeklyWindowStart: now0(), weeklyUsedUsd: 2,
    }))
    expect(await billing.hasBalance('w1', 5)).toBe(false)
  })
  it('enterprise plan is always within balance (uncapped)', async () => {
    setPlan('enterprise')
    wallets.set('w1', freshWallet({ fiveHourUsedUsd: 1e9, weeklyUsedUsd: 1e9 }))
    expect(await billing.hasBalance('w1', 1e9)).toBe(true)
  })
  it('an elapsed five-hour window frees up room', async () => {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000)
    wallets.set('w1', freshWallet({
      fiveHourWindowStart: sixHoursAgo, fiveHourUsedUsd: 0.5, // would block if not reset
      weeklyWindowStart: now0(), weeklyUsedUsd: 0,
    }))
    expect(await billing.hasBalance('w1', 0.1)).toBe(true)
  })

  // Regression: the API server's internal AI-proxy token uses the synthetic
  // `system` workspace which has no Workspace row, so wallet allocation throws
  // on the workspaceId FK. hasBalance must NOT propagate that as a 500 out of
  // the proxy balance preflight — it returns false (clean usage-limit path).
  it('returns false (no throw) when wallet allocation fails for a missing workspace', async () => {
    const origCreate = prismaApi.usageWallet.create
    prismaApi.usageWallet.create = async () => {
      const err: any = new Error(
        'Foreign key constraint violated on the constraint: `credit_ledgers_workspaceId_fkey`',
      )
      err.code = 'P2003'
      throw err
    }
    try {
      // Awaiting directly fails the test if hasBalance rejects (the bug we fixed).
      const result = await billing.hasBalance('system', 0.01)
      expect(result).toBe(false)
    } finally {
      prismaApi.usageWallet.create = origCreate
    }
  })
})

describe('ensureSystemWorkspace', () => {
  it('idempotently creates the system sentinel workspace row', async () => {
    await billing.ensureSystemWorkspace()
    const ws = workspaces.get(billing.SYSTEM_WORKSPACE_ID)
    expect(ws).toBeDefined()
    expect(ws?.id).toBe('system')
    // Once the row exists, allocateFreeWallet for `system` no longer FK-fails,
    // so the internal usage path and any preflight fallback are both safe.
    const wallet = await billing.allocateFreeWallet(billing.SYSTEM_WORKSPACE_ID)
    expect(wallet.workspaceId).toBe('system')
  })
})

// ============================================================================
// consumeUsage (rolling windows)
// ============================================================================
describe('consumeUsage (rolling windows)', () => {
  const base = {
    workspaceId: 'w1', projectId: null, memberId: 'u1',
    actionType: 'chat_message', billedUsd: 0.1,
  }

  it('charges within the window with source=window and increments both windows', async () => {
    wallets.set('w1', freshWallet())
    const r = await billing.consumeUsage({ ...base, billedUsd: 0.2 })
    expect(r.success).toBe(true)
    expect(r.source).toBe('window')
    const w = wallets.get('w1')!
    expect(w.fiveHourUsedUsd).toBeCloseTo(0.2, 5)
    expect(w.weeklyUsedUsd).toBeCloseTo(0.2, 5)
    expect(w.fiveHourWindowStart).toBeInstanceOf(Date)
    expect(w.weeklyWindowStart).toBeInstanceOf(Date)
  })

  it('opens the window on first action then accumulates across calls', async () => {
    wallets.set('w1', freshWallet())
    await billing.consumeUsage({ ...base, billedUsd: 0.1 })
    await billing.consumeUsage({ ...base, billedUsd: 0.1 })
    expect(wallets.get('w1')!.fiveHourUsedUsd).toBeCloseTo(0.2, 5)
  })

  it('blocks with resetsAt + window when exhausted and no overage', async () => {
    const start = now0()
    wallets.set('w1', freshWallet({
      overageEnabled: false,
      fiveHourWindowStart: start, fiveHourUsedUsd: 0.4,  // 5h room = 0.1
      weeklyWindowStart: start, weeklyUsedUsd: 1.95,     // weekly room = 0.05
    }))
    const r = await billing.consumeUsage({ ...base, billedUsd: 0.2 })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Usage limit reached/)
    expect(r.resetsAt).toBeInstanceOf(Date)
    expect(r.window).toBeDefined()
  })

  it('falls through to overage when window exhausted and overage enabled', async () => {
    const start = now0()
    wallets.set('w1', freshWallet({
      overageEnabled: true, overageHardLimitUsd: 1000,
      fiveHourWindowStart: start, fiveHourUsedUsd: 0.5,
      weeklyWindowStart: start, weeklyUsedUsd: 2,
    }))
    const r = await billing.consumeUsage({ ...base, billedUsd: 5 })
    expect(r.success).toBe(true)
    expect(r.source).toBe('overage')
    expect(r.overageChargedUsd).toBe(5)
    const w = wallets.get('w1')!
    expect(w.overageAccumulatedUsd).toBe(5)
    // Beyond-window usage does NOT accrue to the windows.
    expect(w.weeklyUsedUsd).toBe(2)
    expect(w.fiveHourUsedUsd).toBe(0.5)
  })

  it('returns hard-limit error (with resetsAt) when overage room insufficient', async () => {
    const start = now0()
    wallets.set('w1', freshWallet({
      overageEnabled: true, overageHardLimitUsd: 3, overageAccumulatedUsd: 0,
      fiveHourWindowStart: start, fiveHourUsedUsd: 0.5,
      weeklyWindowStart: start, weeklyUsedUsd: 2,
    }))
    const r = await billing.consumeUsage({ ...base, billedUsd: 5 })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/hard limit/)
    expect(r.resetsAt).toBeInstanceOf(Date)
  })

  it('scales window per seat (pro x3 seats → 3x the 5h cap)', async () => {
    setPlan('pro', 3) // 5h = 1.6 * 3 = 4.8, weekly = 4 * 3 = 12
    wallets.set('w1', freshWallet())
    // 2.5 fits the 3-seat 5h cap (4.8) but would exceed the 1-seat cap (1.6).
    const r = await billing.consumeUsage({ ...base, billedUsd: 2.5 })
    expect(r.success).toBe(true)
    expect(r.source).toBe('window')
  })

  it('enterprise is unlimited within windows (no block)', async () => {
    setPlan('enterprise')
    wallets.set('w1', freshWallet())
    const r = await billing.consumeUsage({ ...base, billedUsd: 100000 })
    expect(r.success).toBe(true)
    expect(r.source).toBe('window')
  })

  it('resets the five-hour window once it has elapsed', async () => {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000)
    wallets.set('w1', freshWallet({
      fiveHourWindowStart: sixHoursAgo, fiveHourUsedUsd: 0.5,
      weeklyWindowStart: now0(), weeklyUsedUsd: 0,
    }))
    const r = await billing.consumeUsage({ ...base, billedUsd: 0.1 })
    expect(r.success).toBe(true)
    const w = wallets.get('w1')!
    expect(w.fiveHourUsedUsd).toBeCloseTo(0.1, 5)
    expect(w.fiveHourWindowStart!.getTime()).toBeGreaterThan(sixHoursAgo.getTime())
  })

  it('records a usage event row with source=window', async () => {
    wallets.set('w1', freshWallet())
    await billing.consumeUsage({ ...base, billedUsd: 0.2 })
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].source).toBe('window')
  })
})

// ============================================================================
// getUsageWindows
// ============================================================================
describe('getUsageWindows', () => {
  it('reports utilization and resetsAt for an open window (free)', async () => {
    const start = now0()
    wallets.set('w1', freshWallet({
      fiveHourWindowStart: start, fiveHourUsedUsd: 0.1,   // free 5h cap 0.2 → 50%
      weeklyWindowStart: start, weeklyUsedUsd: 0.125,     // free weekly cap 0.5 → 25%
    }))
    const w = await billing.getUsageWindows('w1')
    expect(w.fiveHour.limitUsd).toBe(0.2)
    expect(w.fiveHour.utilization).toBeCloseTo(0.5, 5)
    expect(w.fiveHour.resetsAt).toBeInstanceOf(Date)
    expect(w.weekly.utilization).toBeCloseTo(0.25, 5)
  })

  it('reports zero usage / null reset for an unopened window', async () => {
    wallets.set('w1', freshWallet())
    const w = await billing.getUsageWindows('w1')
    expect(w.fiveHour.usedUsd).toBe(0)
    expect(w.fiveHour.resetsAt).toBeNull()
  })

  it('clamps utilization to 1 when over the cap', async () => {
    wallets.set('w1', freshWallet({
      fiveHourWindowStart: now0(), fiveHourUsedUsd: 99,
      weeklyWindowStart: now0(), weeklyUsedUsd: 99,
    }))
    const w = await billing.getUsageWindows('w1')
    expect(w.fiveHour.utilization).toBe(1)
  })

  it('returns null limit + zero utilization for uncapped (enterprise)', async () => {
    setPlan('enterprise')
    wallets.set('w1', freshWallet({ fiveHourWindowStart: now0(), fiveHourUsedUsd: 123 }))
    const w = await billing.getUsageWindows('w1')
    expect(w.fiveHour.limitUsd).toBeNull()
    expect(w.fiveHour.utilization).toBe(0)
  })
})

// ============================================================================
// consumeCredits (legacy shim)
// ============================================================================
describe('consumeCredits (legacy)', () => {
  it('converts credit-cost to USD and returns credits-remaining', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 0.5, monthlyIncludedUsd: 10 }))
    // 1 credit → $0.10 billed; leaves room under the free 5h cap ($0.20).
    const r = await billing.consumeCredits('w1', null, 'u', 'x', 1)
    expect(r.success).toBe(true)
    expect(r.remainingCredits).toBeGreaterThan(0)
  })
  it('surfaces error from underlying consumeUsage', async () => {
    const start = new Date()
    wallets.set('w1', freshWallet({
      overageEnabled: false,
      fiveHourWindowStart: start, fiveHourUsedUsd: 0.5, // free 5h cap exhausted
      weeklyWindowStart: start, weeklyUsedUsd: 2,         // free weekly cap exhausted
    }))
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

// ============================================================================
// Coverage gap-closers — consumeUsage transactional branches
// Targets uncovered lines: 257, 400-404, 443-459, 461, 472, 477-483, 532-540,
// 556-563, 573-579, 640-647.
// ============================================================================

describe('nextOverageBlockUsd — outer-guard fallback (L257)', () => {
  it('returns OVERAGE_BLOCK_MAX_USD when remainder exceeds every block size up to the 10_000 iteration cap', () => {
    expect(billing.nextOverageBlockUsd(Number.MAX_SAFE_INTEGER)).toBe(500)
  })
})

describe('consumeUsage — FK retry (L398-404, isFkConstraintError branches)', () => {
  it('retries on usage_events_projectId_fkey P2003 then succeeds', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 1, monthlyIncludedUsd: 0 }))
    let calls = 0
    usageEventCreateImpl = (data) => {
      calls += 1
      if (calls === 1) {
        const err: any = new Error('FK constraint')
        err.code = 'P2003'
        err.meta = { field_name: 'usage_events_projectId_fkey' }
        throw err
      }
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
    const realSetTimeout = setTimeout
    ;(globalThis as any).setTimeout = (cb: any) => realSetTimeout(cb, 0)
    try {
      const r = await billing.consumeUsage({
        workspaceId: 'w1', projectId: 'proj-1', memberId: 'u1',
        actionType: 'x', billedUsd: 0.1,
      })
      expect(r.success).toBe(true)
      expect(calls).toBe(2)
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
    }
  })

  it('re-throws non-FK errors immediately', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 1, monthlyIncludedUsd: 0 }))
    usageEventCreateImpl = () => { throw new Error('connection reset') }
    await expect(
      billing.consumeUsage({
        workspaceId: 'w1', projectId: 'proj-1', memberId: 'u1',
        actionType: 'x', billedUsd: 0.1,
      }),
    ).rejects.toThrow(/connection reset/)
  })

  it('re-throws FK errors after exhausting retry attempts', async () => {
    // Uncapped plan so the (non-transactional) retry loop always reaches the
    // usage-event create — keeps this FK test independent of window cap tuning.
    setPlan('enterprise')
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 1, monthlyIncludedUsd: 0 }))
    usageEventCreateImpl = () => {
      const err: any = new Error('FK constraint')
      err.code = 'P2003'
      err.meta = { field_name: 'usage_events_projectId_fkey' }
      throw err
    }
    const realSetTimeout = setTimeout
    ;(globalThis as any).setTimeout = (cb: any) => realSetTimeout(cb, 0)
    try {
      await expect(
        billing.consumeUsage({
          workspaceId: 'w1', projectId: 'proj-1', memberId: 'u1',
          actionType: 'x', billedUsd: 0.1,
        }),
      ).rejects.toThrow(/FK constraint/)
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
    }
  })

  it('does NOT retry FK errors when projectId is null', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 1, monthlyIncludedUsd: 0 }))
    let calls = 0
    usageEventCreateImpl = () => {
      calls += 1
      const err: any = new Error('FK constraint')
      err.code = 'P2003'
      err.meta = { field_name: 'usage_events_projectId_fkey' }
      throw err
    }
    await expect(
      billing.consumeUsage({
        workspaceId: 'w1', projectId: null, memberId: 'u1',
        actionType: 'x', billedUsd: 0.1,
      }),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('isFkConstraintError returns false for P2002 (different code)', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 1, monthlyIncludedUsd: 0 }))
    usageEventCreateImpl = () => {
      const err: any = new Error('unique violation')
      err.code = 'P2002'
      err.meta = { field_name: 'usage_events_projectId_fkey' }
      throw err
    }
    await expect(
      billing.consumeUsage({
        workspaceId: 'w1', projectId: 'p1', memberId: 'u1',
        actionType: 'x', billedUsd: 0.1,
      }),
    ).rejects.toThrow(/unique violation/)
  })

  it('isFkConstraintError returns false for P2003 with wrong field_name', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 1, monthlyIncludedUsd: 0 }))
    usageEventCreateImpl = () => {
      const err: any = new Error('FK other')
      err.code = 'P2003'
      err.meta = { field_name: 'usage_events_memberId_fkey' }
      throw err
    }
    await expect(
      billing.consumeUsage({
        workspaceId: 'w1', projectId: 'p1', memberId: 'u1',
        actionType: 'x', billedUsd: 0.1,
      }),
    ).rejects.toThrow(/FK other/)
  })

  it('isFkConstraintError returns false for non-object errors', async () => {
    wallets.set('w1', freshWallet({ dailyIncludedUsd: 1, monthlyIncludedUsd: 0 }))
    usageEventCreateImpl = () => { throw 'just a string' }
    await expect(
      billing.consumeUsage({
        workspaceId: 'w1', projectId: 'p1', memberId: 'u1',
        actionType: 'x', billedUsd: 0.1,
      }),
    ).rejects.toBe('just a string')
  })
})

describe('consumeUsage — wallet allocation fallback (L532-540)', () => {
  it('returns failure when allocateFreeWallet throws and wallet stays missing', async () => {
    const origCreate = prismaApi.usageWallet.create
    prismaApi.usageWallet.create = async () => { throw new Error('allocate explosion') }
    try {
      const r = await billing.consumeUsage({
        workspaceId: 'w1', projectId: null, memberId: 'u1',
        actionType: 'x', billedUsd: 0.1,
      })
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/No usage wallet found/)
    } finally {
      prismaApi.usageWallet.create = origCreate
    }
  })

  it('allocates a wallet on the fly when none pre-exists', async () => {
    const r = await billing.consumeUsage({
      workspaceId: 'w1', projectId: null, memberId: 'u1',
      actionType: 'x', billedUsd: 0.1,
    })
    expect(r.success).toBe(true)
    expect(wallets.get('w1')).toBeDefined()
  })
})

describe('consumeUsage — monthly boundary resets overage bookkeeping', () => {
  it('zeros accumulated/billed overage and advances lastMonthlyReset on month rollover', async () => {
    const lastMonth = new Date()
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1)
    // Window is exhausted so the charge takes the overage path; the month
    // boundary should have already zeroed prior overage accumulation.
    const start = now0()
    wallets.set('w1', freshWallet({
      overageEnabled: true, overageHardLimitUsd: 1000,
      overageAccumulatedUsd: 25, overageBilledUsd: 100,
      lastMonthlyReset: lastMonth,
      fiveHourWindowStart: start, fiveHourUsedUsd: 0.5,
      weeklyWindowStart: start, weeklyUsedUsd: 2,
    }))
    const r = await billing.consumeUsage({
      workspaceId: 'w1', projectId: null, memberId: 'u1',
      actionType: 'x', billedUsd: 5,
    })
    expect(r.success).toBe(true)
    expect(r.source).toBe('overage')
    const w = wallets.get('w1')!
    // Prior 25 was zeroed on the boundary, then 5 charged this period.
    expect(w.overageAccumulatedUsd).toBe(5)
    expect(w.overageBilledUsd).toBe(0)
    expect(+w.lastMonthlyReset).toBeGreaterThan(+lastMonth)
  })

  it('does not drain the legacy monthly included pool on a normal charge', async () => {
    wallets.set('w1', freshWallet({ monthlyIncludedUsd: 100 }))
    const r = await billing.consumeUsage({
      workspaceId: 'w1', projectId: null, memberId: 'u1',
      actionType: 'x', billedUsd: 0.1,
    })
    expect(r.success).toBe(true)
    expect(r.source).toBe('window')
    // The vestigial monthly pool is untouched by the window path.
    expect(wallets.get('w1')!.monthlyIncludedUsd).toBe(100)
  })
})

// ============================================================================
// Pooled child workspaces (Business/Enterprise parent)
// ============================================================================
describe('pooled child workspaces', () => {
  function setupFamily() {
    workspaces.set('parent', { id: 'parent', name: 'Parent', slug: 'parent', parentWorkspaceId: null })
    workspaces.set('child', { id: 'child', name: 'Child', slug: 'child', parentWorkspaceId: 'parent' })
  }

  it('resolveBillingWorkspaceId returns the parent for a child and self for a top-level workspace', async () => {
    setupFamily()
    expect(await billing.resolveBillingWorkspaceId('child')).toBe('parent')
    expect(await billing.resolveBillingWorkspaceId('parent')).toBe('parent')
    // Unknown workspace resolves to itself (no row -> no parent).
    expect(await billing.resolveBillingWorkspaceId('ghost')).toBe('ghost')
  })

  it('getEffectivePlanId for a child resolves to the parent plan', async () => {
    setupFamily()
    setPlan('business', 3, 'parent')
    expect(await billing.getEffectivePlanId('child')).toBe('business')
    // The child itself has no subscription row.
    expect(subs.get('child')).toBeUndefined()
  })

  it('getUsageWallet for a child returns the parent wallet', async () => {
    setupFamily()
    wallets.set('parent', freshWallet({ workspaceId: 'parent' }))
    const w = await billing.getUsageWallet('child')
    expect(w?.workspaceId).toBe('parent')
  })

  it('consumeUsage on a child debits the parent wallet but attributes the event to the child', async () => {
    setupFamily()
    setPlan('business', 3, 'parent') // finite rolling windows
    wallets.set('parent', freshWallet({ workspaceId: 'parent' }))

    const r = await billing.consumeUsage({
      workspaceId: 'child', projectId: null, memberId: 'u1',
      actionType: 'ai_proxy_completion', billedUsd: 0.5,
    })

    expect(r.success).toBe(true)
    // The child never gets its own wallet — usage is pooled to the parent.
    expect(wallets.get('child')).toBeUndefined()
    expect(wallets.get('parent')!.fiveHourUsedUsd).toBeGreaterThan(0)
    // The usage event is still attributed to the child for per-child reporting.
    const ev = usageEvents.find((e) => e.actionType === 'ai_proxy_completion')
    expect(ev?.workspaceId).toBe('child')
  })

  it('countActiveWorkspaceMembers pools distinct members across the family', async () => {
    setupFamily()
    members.push(
      { workspaceId: 'parent', userId: 'u1', projectId: null },
      { workspaceId: 'child', userId: 'u2', projectId: null },
      { workspaceId: 'child', userId: 'u1', projectId: null }, // same user counts once
    )
    // Counting from either the parent or a child yields the family total.
    expect(await billing.countActiveWorkspaceMembers('parent')).toBe(2)
    expect(await billing.countActiveWorkspaceMembers('child')).toBe(2)
  })
})
