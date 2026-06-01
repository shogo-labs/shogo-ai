// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
process.env.STRIPE_SECRET_KEY = 'sk_test_local'

const usageEventCreates: any[] = []
let usageEventCreateError: Error | null = null

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    usageEvent: {
      create: mock(async (args: any) => {
        if (usageEventCreateError) throw usageEventCreateError
        usageEventCreates.push(args)
        return { id: `usage-${usageEventCreates.length}`, ...args.data }
      }),
    },
  },
}))

mock.module('../config/usage-plans', () => ({
  FREE_DAILY_INCLUDED_USD: 1,
  MONTHLY_DAILY_CAP_USD: 30,
  FIVE_HOUR_MS: 5 * 60 * 60 * 1000,
  SEVEN_DAY_MS: 7 * 24 * 60 * 60 * 1000,
  PLAN_INCLUDED_USD: { free: 0, basic: 5, pro: 20, business: 40 },
  PLAN_RANK: { free: 0, basic: 1, pro: 2, business: 3, enterprise: 4 },
  SEAT_INCLUDED_USD: { free: 0, basic: 5, pro: 20, business: 40, enterprise: 2000 },
  ROLLING_WINDOW_LIMITS: {
    free: { fiveHourUsd: 0.5, weeklyUsd: 2 },
    basic: { fiveHourUsd: 2, weeklyUsd: 10 },
    pro: { fiveHourUsd: 8, weeklyUsd: 40 },
    business: { fiveHourUsd: 20, weeklyUsd: 120 },
    enterprise: null,
  },
  getWindowLimitsForPlan: () => ({ fiveHourUsd: 0.5, weeklyUsd: 2 }),
  getDailyIncludedForPlan: (planId: string | null | undefined) => {
    const lc = (planId ?? 'free').toString().toLowerCase().trim()
    return lc.startsWith('free') || lc === '' ? 1 : 0
  },
  getMonthlyIncludedForPlan: () => 0,
  normalizePlanId: (p: string | null | undefined) => (p ?? null),
  comparePlanRank: () => 0,
}))

mock.module('../config/stripe-prices', () => ({
  getOveragePriceConfig: () => ({ priceId: 'price_overage_metered' }),
}))

mock.module('stripe', () => ({
  default: class FakeStripe {},
}))

const billing = await import('../services/billing.service')

beforeEach(() => {
  usageEventCreates.length = 0
  usageEventCreateError = null
})

describe('billing service local mode', () => {
  test('consumeUsage records a zero-cost daily usage event and returns infinite balance', async () => {
    const result = await billing.consumeUsage({
      workspaceId: 'ws-local',
      projectId: 'project-1',
      memberId: 'member-1',
      actionType: 'chat',
      rawUsd: 0.25,
      billedUsd: 999,
      actionMetadata: { tool: 'agent' },
    })

    expect(result).toEqual({
      success: true,
      remainingIncludedUsd: Infinity,
      overageChargedUsd: 0,
      source: 'daily',
    })
    expect(usageEventCreates[0].data).toMatchObject({
      workspaceId: 'ws-local',
      projectId: 'project-1',
      memberId: 'member-1',
      actionType: 'chat',
      rawUsd: 0.25,
      billedUsd: 0,
      source: 'daily',
      balanceBefore: 0,
      balanceAfter: 0,
      actionMetadata: { tool: 'agent' },
    })
  })

  test('consumeUsage remains successful when local usage-event recording fails', async () => {
    usageEventCreateError = new Error('local db offline')

    const result = await billing.consumeUsage({
      workspaceId: 'ws-local',
      projectId: null,
      memberId: 'member-1',
      actionType: 'chat',
      billedUsd: 10,
    })

    expect(result.success).toBe(true)
    expect(result.remainingIncludedUsd).toBe(Infinity)
    expect(usageEventCreates).toHaveLength(0)
  })
})
