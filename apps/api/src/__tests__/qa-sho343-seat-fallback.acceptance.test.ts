// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-343, the v2.5.0 seat-fallback regression.
 *
 * Runs the real billing code against a real database (desktop SQLite
 * migrations by default; Postgres with `CHANNELS_TEST_PG_URL`) so the
 * family-seat lookup, the pooled allowance and the grant allowance are
 * exercised end to end, not against hand-built mocks:
 *
 *   1. A member of a child workspace is a seat of the parent: the preflight
 *      admits them, the debit lands on their child Member row, and the
 *      parent's wallet counters are untouched.
 *   2. A user who is a member of both the parent and a child is metered on the
 *      parent row only (one seat per user per billing account).
 *   3. Seatless usage on a paid workspace meters the pooled allowance
 *      (per-seat × seats), never one seat's worth.
 *   4. The free tier keeps its single shared allowance.
 *   5. A Business grant keeps the legacy $40-seat allowance, and its
 *      `monthlyIncludedUsd` raises the per-seat weekly allowance when higher.
 *   6. The subscription and the grant combine by max per window; an enterprise
 *      grant makes the workspace uncapped.
 *   7. `hasBalance` with a member id meters that member's seat.
 *   8. A refusal logs one structured `[billing] usage refused` line.
 */

import { describe, expect, test, spyOn } from 'bun:test'

const { setupChannelsTestDb } = await import('./helpers/channels-test-db')
setupChannelsTestDb()

// The helper flags local mode so `lib/prisma` builds a SQLite client. Bind it
// first, then clear the flag so `billing.service` exercises its cloud metering
// path (`isLocalMode` is captured at import) instead of `recordLocalUsage`.
const { prisma } = await import('../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

const billing = await import('../services/billing.service')
const { WEEKS_PER_MONTH, LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS } = await import(
  '../config/usage-plans'
)
const db = prisma as any

/** Business is $4.60/week per seat and $1.84 per 5 hours (usage-plans.ts). */
const BUSINESS_WEEKLY_USD = 4.6
const BUSINESS_FIVE_HOUR_USD = 1.84
/** The v2.5.0 Business seat price — a Business row with no price is legacy. */
const NEW_BUSINESS_PRICE = 'business_seat_monthly_v2'

let seq = 0

interface Family {
  parentId: string
  childId: string
}

/**
 * A parent workspace with one child, an optional subscription and grant, and a
 * wallet whose rolling counters can be pre-loaded (the "wallet already used
 * more than one seat's allowance" state from the incident).
 */
async function seedFamily(opts: {
  seats?: number
  stripePriceId?: string | null
  grant?: { planId: string; freeSeats: number; monthlyIncludedUsd?: number } | null
  walletWeeklyUsedUsd?: number
  walletFiveHourUsedUsd?: number
} = {}): Promise<Family> {
  const suffix = `${crypto.randomUUID().slice(0, 8)}-${++seq}`
  const parent = await db.workspace.create({
    data: { name: `Parent ${suffix}`, slug: `parent-${suffix}`, kind: 'team' },
  })
  const child = await db.workspace.create({
    data: {
      name: `Child ${suffix}`,
      slug: `child-${suffix}`,
      kind: 'team',
      parentWorkspaceId: parent.id,
    },
  })
  const now = new Date()
  if (opts.seats != null) {
    await db.subscription.create({
      data: {
        workspaceId: parent.id,
        stripeSubscriptionId: `sub_${suffix}`,
        stripeCustomerId: `cus_${suffix}`,
        planId: 'business',
        seats: opts.seats,
        status: 'active',
        billingInterval: 'monthly',
        stripePriceId: opts.stripePriceId === undefined ? NEW_BUSINESS_PRICE : opts.stripePriceId,
        currentPeriodStart: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000),
      },
    })
  }
  if (opts.grant) {
    await db.workspaceGrant.create({
      data: {
        workspaceId: parent.id,
        planId: opts.grant.planId,
        freeSeats: opts.grant.freeSeats,
        monthlyIncludedUsd: opts.grant.monthlyIncludedUsd ?? 0,
        startsAt: new Date(now.getTime() - 60 * 1000),
      },
    })
  }
  const weeklyUsed = opts.walletWeeklyUsedUsd ?? 0
  const fiveUsed = opts.walletFiveHourUsedUsd ?? 0
  await db.usageWallet.create({
    data: {
      workspaceId: parent.id,
      monthlyIncludedUsd: 0,
      dailyIncludedUsd: 0,
      overageEnabled: false,
      overageAccumulatedUsd: 0,
      anniversaryDay: 1,
      lastDailyReset: now,
      lastMonthlyReset: now,
      ...(weeklyUsed > 0 || fiveUsed > 0
        ? {
            fiveHourWindowStart: now,
            fiveHourUsedUsd: fiveUsed,
            weeklyWindowStart: now,
            weeklyUsedUsd: weeklyUsed,
          }
        : {}),
    },
  })
  return { parentId: parent.id, childId: child.id }
}

async function makeUser(workspaceIds: string[]): Promise<{ userId: string; memberIds: string[] }> {
  const suffix = `${crypto.randomUUID().slice(0, 8)}-${++seq}`
  const user = await db.user.create({
    data: { name: `user-${suffix}`, email: `user-${suffix}@example.com` },
  })
  const memberIds: string[] = []
  for (const workspaceId of workspaceIds) {
    const m = await db.member.create({
      data: { userId: user.id, workspaceId, projectId: null, role: 'member' },
    })
    memberIds.push(m.id)
  }
  return { userId: user.id, memberIds }
}

const spend = (workspaceId: string, memberId: string, billedUsd: number) =>
  billing.consumeUsage({ workspaceId, projectId: null, memberId, actionType: 'chat', billedUsd })

describe('SHO-343 seat fallback (real database)', () => {
  test('a child-workspace member is a seat of the parent', async () => {
    // The incident state: the parent's wallet already holds more than one
    // seat's weekly allowance, which used to block every seatless caller.
    const { parentId, childId } = await seedFamily({
      seats: 3,
      walletWeeklyUsedUsd: 20,
      walletFiveHourUsedUsd: 5,
    })
    const { userId, memberIds } = await makeUser([childId])

    // Preflight admits the child member on their own seat.
    expect((await billing.checkUsageBalance(childId, 0.001, userId)).ok).toBe(true)

    // The debit lands on the child Member row, not the pooled wallet.
    const res = await spend(childId, userId, 1)
    expect(res.success).toBe(true)
    expect(res.source).toBe('window')

    const childMember = await db.member.findUnique({ where: { id: memberIds[0] } })
    expect(childMember.weeklyUsedUsd).toBeCloseTo(1)
    expect(childMember.fiveHourUsedUsd).toBeCloseTo(1)

    const wallet = await db.usageWallet.findUnique({ where: { workspaceId: parentId } })
    expect(wallet.weeklyUsedUsd).toBeCloseTo(20)
    expect(wallet.fiveHourUsedUsd).toBeCloseTo(5)

    // The display reports that seat's used/limit, not the pooled wallet.
    const windows = await billing.getUsageWindows(childId, userId)
    expect(windows.weekly.usedUsd).toBeCloseTo(1)
    expect(windows.weekly.limitUsd).toBeCloseTo(BUSINESS_WEEKLY_USD)
    expect(windows.fiveHour.limitUsd).toBeCloseTo(BUSINESS_FIVE_HOUR_USD)
  })

  test('a user in both parent and child is metered on the parent row only', async () => {
    const { parentId, childId } = await seedFamily({ seats: 3 })
    const { userId, memberIds } = await makeUser([parentId, childId])
    const [parentMemberId, childMemberId] = memberIds

    const res = await spend(childId, userId, 1)
    expect(res.success).toBe(true)

    const parentMember = await db.member.findUnique({ where: { id: parentMemberId } })
    const childMember = await db.member.findUnique({ where: { id: childMemberId } })
    expect(parentMember.weeklyUsedUsd).toBeCloseTo(1)
    expect(childMember.weeklyUsedUsd).toBe(0)
  })

  test('seatless usage on a paid workspace meters the pooled allowance', async () => {
    const { parentId } = await seedFamily({ seats: 5 })

    // 5 seats × $4.60/week and × $1.84/5h.
    const windows = await billing.getUsageWindows(parentId)
    expect(windows.weekly.limitUsd).toBeCloseTo(BUSINESS_WEEKLY_USD * 5)
    expect(windows.fiveHour.limitUsd).toBeCloseTo(BUSINESS_FIVE_HOUR_USD * 5)

    // $5 is more than one seat's weekly allowance but well inside the pool.
    const res = await spend(parentId, 'system', 5)
    expect(res.success).toBe(true)
    expect(res.source).toBe('window')

    const wallet = await db.usageWallet.findUnique({ where: { workspaceId: parentId } })
    expect(wallet.weeklyUsedUsd).toBeCloseTo(5)
  })

  test('a single-seat workspace still blocks the same seatless spend', async () => {
    const { parentId } = await seedFamily({ seats: 1 })
    const res = await spend(parentId, 'system', 5)
    expect(res.success).toBe(false)
    expect(res.reason).toBe('usage_limit_reached')
  })

  test('the free tier keeps its single shared allowance', async () => {
    const { parentId } = await seedFamily()
    const { userId: a } = await makeUser([parentId])
    const { userId: b } = await makeUser([parentId])

    const windows = await billing.getUsageWindows(parentId)
    expect(windows.weekly.limitUsd).toBeCloseTo(0.5)
    expect(windows.fiveHour.limitUsd).toBeCloseTo(0.2)

    // One shared wallet: A's spend is visible on B's seat view.
    expect((await spend(parentId, a, 0.15)).success).toBe(true)
    const bWindows = await billing.getUsageWindows(parentId, b)
    expect(bWindows.weekly.usedUsd).toBeCloseTo(0.15)
    expect(bWindows.weekly.limitUsd).toBeCloseTo(0.5)

    // And the shared 5-hour guard still stops the next call.
    const over = await spend(parentId, b, 0.1)
    expect(over.success).toBe(false)
    expect(over.reason).toBe('usage_limit_reached')
  })

  test('a Business grant keeps the legacy $40-seat allowance', async () => {
    const { parentId } = await seedFamily({
      grant: { planId: 'business', freeSeats: 10 },
    })
    const { userId } = await makeUser([parentId])

    const seat = await billing.getUsageWindows(parentId, userId)
    expect(seat.fiveHour.limitUsd).toBeCloseTo(LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS.fiveHourUsd)
    expect(seat.weekly.limitUsd).toBeCloseTo(LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS.weeklyUsd)

    // Seatless usage pools the grant's 10 free seats.
    const pooled = await billing.getUsageWindows(parentId)
    expect(pooled.weekly.limitUsd).toBeCloseTo(
      LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS.weeklyUsd * 10,
    )
  })

  test('a grant monthlyIncludedUsd raises the per-seat weekly allowance', async () => {
    const { parentId } = await seedFamily({
      grant: { planId: 'business', freeSeats: 10, monthlyIncludedUsd: 2000 },
    })
    const { userId } = await makeUser([parentId])

    const expectedWeekly = 2000 / 10 / WEEKS_PER_MONTH
    const expectedFiveHour =
      expectedWeekly *
      (LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS.fiveHourUsd /
        LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS.weeklyUsd)

    const windows = await billing.getUsageWindows(parentId, userId)
    expect(windows.weekly.limitUsd).toBeCloseTo(expectedWeekly)
    expect(windows.fiveHour.limitUsd).toBeCloseTo(expectedFiveHour)
  })

  test('a higher grant beats the subscription per window', async () => {
    const { parentId } = await seedFamily({
      seats: 1,
      stripePriceId: NEW_BUSINESS_PRICE,
      grant: { planId: 'business', freeSeats: 1, monthlyIncludedUsd: 500 },
    })
    const { userId } = await makeUser([parentId])

    const expectedWeekly = 500 / 1 / WEEKS_PER_MONTH
    const windows = await billing.getUsageWindows(parentId, userId)
    expect(windows.weekly.limitUsd).toBeCloseTo(expectedWeekly)
    expect(windows.weekly.limitUsd).toBeGreaterThan(BUSINESS_WEEKLY_USD)
  })

  test('an enterprise grant makes a subscribed workspace uncapped', async () => {
    const { parentId } = await seedFamily({
      seats: 1,
      stripePriceId: NEW_BUSINESS_PRICE,
      grant: { planId: 'enterprise', freeSeats: 1 },
    })
    const { userId } = await makeUser([parentId])

    const windows = await billing.getUsageWindows(parentId, userId)
    expect(windows.weekly.limitUsd).toBeNull()
    expect(windows.fiveHour.limitUsd).toBeNull()
    expect((await billing.checkUsageBalance(parentId, 0.001, userId)).ok).toBe(true)
  })

  test('hasBalance with a member id meters that member’s seat', async () => {
    const { parentId } = await seedFamily({ seats: 3 })
    const { userId: exhausted } = await makeUser([parentId])
    const { userId: fresh } = await makeUser([parentId])

    // Exhaust the first seat's windows.
    const now = new Date()
    await db.member.updateMany({
      where: { workspaceId: parentId, userId: exhausted },
      data: {
        fiveHourWindowStart: now,
        fiveHourUsedUsd: BUSINESS_FIVE_HOUR_USD,
        weeklyWindowStart: now,
        weeklyUsedUsd: BUSINESS_WEEKLY_USD,
      },
    })

    expect(await billing.hasBalance(parentId, 0.001, exhausted)).toBe(false)
    expect(await billing.hasBalance(parentId, 0.001, fresh)).toBe(true)
    // Seatless callers get the pooled allowance, so they are not blocked by
    // one exhausted seat.
    expect(await billing.hasBalance(parentId, 0.001)).toBe(true)
  })

  test('a refusal logs one structured [billing] usage refused line', async () => {
    const { parentId } = await seedFamily()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await billing.checkUsageBalance(parentId, 100)
      expect(res.ok).toBe(false)

      const refused = warn.mock.calls.find((c) => c[0] === '[billing] usage refused')
      expect(refused).toBeDefined()
      const fields = refused![1] as Record<string, unknown>
      expect(fields.workspaceId).toBe(parentId)
      expect(fields.billingWorkspaceId).toBe(parentId)
      expect(fields.scope).toBe('free')
      expect(fields.reason).toBe('usage_limit_reached')
      // The 5-hour guard is the binding window on an untouched free wallet.
      expect(fields.window).toBe('five_hour')
      expect(fields.limitUsd).toBeCloseTo(0.2)
    } finally {
      warn.mockRestore()
    }
  })
})
