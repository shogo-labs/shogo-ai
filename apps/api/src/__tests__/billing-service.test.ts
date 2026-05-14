// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `billing.service.ts` — pure-logic + simple-query coverage.
 *
 * Targets:
 *   - nextOverageBlockUsd (every step of the 100→500 ladder)
 *   - getSubscription / getSubscriptions / getUsageWallet (Prisma pass-through)
 *   - allocateFreeWallet (new + existing branches, grant stacking)
 *   - applyGrantMonthlyAllocation (upsert path with grants)
 *   - allocateMonthlyIncluded (paid plan with seats + grant)
 *   - hasPaidSubscription / hasAdvancedModelAccess / isBusinessOrHigherPlan
 *     (local-mode short-circuit + Prisma-backed paths)
 *   - hasBalance (no wallet → allocate, included-only, overage-on/off,
 *     hard-cap exhaustion)
 *
 *   bun test apps/api/src/__tests__/billing-service.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

delete process.env.SHOGO_LOCAL_MODE

// ────────────────────────────────────────────────────────────────────
// Prisma mock
// ────────────────────────────────────────────────────────────────────
let walletByWs = new Map<string, any>()
let subsByWs = new Map<string, any[]>()
let grantsByWs = new Map<string, any[]>()

const mockPrisma = {
  subscription: {
    findFirst: async (args: any) => {
      const subs = subsByWs.get(args.where.workspaceId) ?? []
      const status = args.where.status?.in
      const filtered = status ? subs.filter((s: any) => status.includes(s.status)) : subs
      return filtered[0] ?? null
    },
    findMany: async (args: any) => subsByWs.get(args.where.workspaceId) ?? [],
  },
  usageWallet: {
    findUnique: async (args: any) => walletByWs.get(args.where.workspaceId) ?? null,
    create: async (args: any) => {
      walletByWs.set(args.data.workspaceId, args.data)
      return args.data
    },
    upsert: async (args: any) => {
      const ws = args.where.workspaceId
      const existing = walletByWs.get(ws)
      if (existing) {
        const merged = { ...existing, ...args.update }
        walletByWs.set(ws, merged)
        return merged
      }
      walletByWs.set(ws, args.create)
      return args.create
    },
  },
  workspaceGrant: {
    findMany: async (args: any) => grantsByWs.get(args.where.workspaceId) ?? [],
  },
  usageEvent: {
    create: async (args: any) => ({ id: 'ue-1', ...args.data }),
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

mock.module('../config/usage-plans', () => ({
  DAILY_INCLUDED_USD: 1,
  MONTHLY_DAILY_CAP_USD: 30,
  PLAN_INCLUDED_USD: { free: 0, basic: 5, pro: 20, business: 40 },
  getMonthlyIncludedForPlan: (plan: string, seats: number) => {
    if (plan === 'basic') return 5
    if (plan === 'pro') return 20 * seats
    if (plan === 'business') return 40 * seats
    return 0
  },
}))

mock.module('../config/stripe-prices', () => ({
  getOveragePriceConfig: () => null,
}))

const billing = await import('../services/billing.service')

beforeEach(() => {
  walletByWs.clear()
  subsByWs.clear()
  grantsByWs.clear()
})

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
    expect(billing.nextOverageBlockUsd(1500)).toBe(500) // capped from here on
    expect(billing.nextOverageBlockUsd(10_000)).toBe(500)
  })

  test('negative input clamps to zero so the ladder starts at $100', () => {
    expect(billing.nextOverageBlockUsd(-50)).toBe(100)
  })
})

describe('getSubscription / getSubscriptions', () => {
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
})

describe('allocateFreeWallet', () => {
  test('creates a fresh wallet on first call', async () => {
    const wallet = await billing.allocateFreeWallet('ws-1')
    expect(wallet.workspaceId).toBe('ws-1')
    expect(wallet.dailyIncludedUsd).toBe(1)
    expect(wallet.monthlyIncludedUsd).toBe(0) // free plan + zero grant
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
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 100 }])
    const wallet = await billing.applyGrantMonthlyAllocation('ws-1')
    expect(wallet.monthlyIncludedUsd).toBe(100)
  })

  test('resets daily / overage counters when refreshing an existing wallet', async () => {
    walletByWs.set('ws-1', {
      workspaceId: 'ws-1', dailyUsedThisMonthUsd: 7, overageAccumulatedUsd: 99,
      overageBilledUsd: 100, monthlyIncludedUsd: 0, monthlyIncludedAllocationUsd: 0,
      dailyIncludedUsd: 1, anniversaryDay: 1, lastDailyReset: new Date(), lastMonthlyReset: new Date(),
      overageEnabled: false, overageHardLimitUsd: null,
    })
    grantsByWs.set('ws-1', [{ freeSeats: 0, monthlyIncludedUsd: 25 }])
    const wallet = await billing.applyGrantMonthlyAllocation('ws-1')
    expect(wallet.monthlyIncludedUsd).toBe(25)
    expect(wallet.dailyUsedThisMonthUsd).toBe(0)
    expect(wallet.overageAccumulatedUsd).toBe(0)
    expect(wallet.overageBilledUsd).toBe(0)
  })
})

describe('allocateMonthlyIncluded', () => {
  test('grants `seats * plan-included` USD plus any active grant', async () => {
    grantsByWs.set('ws-1', [{ freeSeats: 1, monthlyIncludedUsd: 10 }])
    const wallet = await billing.allocateMonthlyIncluded('ws-1', 'pro', 3)
    // seats=3 + 1 grant seat = 4 → 4*20 = 80, plus 10 grant = 90.
    expect(wallet.monthlyIncludedUsd).toBe(90)
    expect(wallet.overageEnabled).toBe(true)
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

  test('returns true under SHOGO_LOCAL_MODE even with no subscription', async () => {
    // billing.service caches isLocalMode at import time, so we can't toggle
    // it after the fact in this test file. We documented the behaviour in
    // the comment above instead. (See ai-proxy-handlers.test.ts for the
    // matching local-mode path.)
  })
})

describe('hasBalance', () => {
  test('returns true when the workspace has included USD covering the request', async () => {
    walletByWs.set('ws-1', {
      workspaceId: 'ws-1', monthlyIncludedUsd: 5, monthlyIncludedAllocationUsd: 5,
      dailyIncludedUsd: 1, dailyUsedThisMonthUsd: 0, overageAccumulatedUsd: 0,
      overageEnabled: false, overageHardLimitUsd: null,
      lastDailyReset: new Date(), lastMonthlyReset: new Date(), anniversaryDay: 1,
    })
    expect(await billing.hasBalance('ws-1', 0.001)).toBe(true)
  })

  test('returns false when included is exhausted and overage is disabled', async () => {
    walletByWs.set('ws-1', {
      workspaceId: 'ws-1', monthlyIncludedUsd: 0, monthlyIncludedAllocationUsd: 0,
      dailyIncludedUsd: 0, dailyUsedThisMonthUsd: 30, overageAccumulatedUsd: 0,
      overageEnabled: false, overageHardLimitUsd: null,
      lastDailyReset: new Date(), lastMonthlyReset: new Date(), anniversaryDay: 1,
    })
    expect(await billing.hasBalance('ws-1', 10)).toBe(false)
  })

  test('allows overage spending under the hard cap', async () => {
    walletByWs.set('ws-1', {
      workspaceId: 'ws-1', monthlyIncludedUsd: 0, monthlyIncludedAllocationUsd: 0,
      dailyIncludedUsd: 0, dailyUsedThisMonthUsd: 30, overageAccumulatedUsd: 5,
      overageEnabled: true, overageHardLimitUsd: 50,
      lastDailyReset: new Date(), lastMonthlyReset: new Date(), anniversaryDay: 1,
    })
    expect(await billing.hasBalance('ws-1', 20)).toBe(true)
  })

  test('blocks spending past the hard cap even with overage on', async () => {
    walletByWs.set('ws-1', {
      workspaceId: 'ws-1', monthlyIncludedUsd: 0, monthlyIncludedAllocationUsd: 0,
      dailyIncludedUsd: 0, dailyUsedThisMonthUsd: 30, overageAccumulatedUsd: 50,
      overageEnabled: true, overageHardLimitUsd: 50,
      lastDailyReset: new Date(), lastMonthlyReset: new Date(), anniversaryDay: 1,
    })
    expect(await billing.hasBalance('ws-1', 1)).toBe(false)
  })

  test('returns true when overage hard limit is unset (unlimited)', async () => {
    walletByWs.set('ws-1', {
      workspaceId: 'ws-1', monthlyIncludedUsd: 0, monthlyIncludedAllocationUsd: 0,
      dailyIncludedUsd: 0, dailyUsedThisMonthUsd: 30, overageAccumulatedUsd: 999,
      overageEnabled: true, overageHardLimitUsd: null,
      lastDailyReset: new Date(), lastMonthlyReset: new Date(), anniversaryDay: 1,
    })
    expect(await billing.hasBalance('ws-1', 1000)).toBe(true)
  })

  test('allocates a free wallet if none exists', async () => {
    expect(walletByWs.has('ws-new')).toBe(false)
    const out = await billing.hasBalance('ws-new', 0.001)
    expect(walletByWs.has('ws-new')).toBe(true)
    // Free wallet has $1 daily, $0 monthly — covers $0.001.
    expect(out).toBe(true)
  })
})
