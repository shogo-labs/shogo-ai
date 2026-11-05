// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-312, the per-seat weekly AI allowance.
 *
 * The card's own tests mock `lib/prisma` wholesale, so no column ever reaches a
 * real query: the per-seat behaviour is proven against hand-built objects. This
 * file closes that gap and runs the same code path against a real database
 * (desktop SQLite migrations by default; Postgres with `CHANNELS_TEST_PG_URL`),
 * which also exercises the additive `members.*Window*` migration on both
 * tracks:
 *
 *   1. One member exhausting its window blocks that member and leaves every
 *      other seat's allowance untouched — the card's headline criterion.
 *   2. The workspace wallet accrues nothing on a paid plan (no pooled bucket),
 *      and the counters really land on the `members` rows.
 *   3. A 3-seat Business workspace does NOT hand one member a 3× allowance.
 *   4. `getUsageWindows` / `checkUsageBalance` answer for the caller's own seat,
 *      which is what every 402 preflight and the client's usage bars read.
 *   5. Usage with no seat behind it (`system`) still meters against the wallet,
 *      so unattributed spend is not silently free.
 */

import { describe, expect, test } from 'bun:test'

const { setupChannelsTestDb } = await import('./helpers/channels-test-db')
setupChannelsTestDb()

// The helper flags local mode so `lib/prisma` builds a SQLite client. Bind it
// first, then clear the flag so `billing.service` exercises its cloud metering
// path (`isLocalMode` is captured at import) instead of `recordLocalUsage`.
const { prisma } = await import('../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

const billing = await import('../services/billing.service')
const { LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS } = await import('../config/usage-plans')
const db = prisma as any

/** Business is $4.60/week per seat and $1.84 per 5 hours (usage-plans.ts). */
const BUSINESS_WEEKLY_USD = 4.6
const BUSINESS_FIVE_HOUR_USD = 1.84

/**
 * The v2.5.0 Business seat price. The allowance follows the price, so a seat
 * only sees today's $4.60/$1.84 once the subscription carries this id — a
 * Business row with no price at all is a pre-v2.5.0 $40 seat (see
 * `getPlanAllowance`), which is what the legacy test below pins down.
 */
const NEW_BUSINESS_MONTHLY = 'price_business_seat_monthly_v2'

interface Seeded {
  workspaceId: string
  /** Three paying seats. */
  userIds: string[]
  memberIds: string[]
}

let seq = 0

/**
 * A 3-seat Business workspace with overage *off*, so an exhausted window is a
 * hard block and the assertions are about the allowance, not about billing.
 *
 * `stripePriceId` is the price the workspace pays: the v2.5.0 $16 seat id a new
 * checkout writes, or `null` for a row that predates the `stripePriceId`
 * column (i.e. a $40 seat that has not reached its next renewal yet).
 */
async function seedPaidWorkspace(
  stripePriceId: string | null = NEW_BUSINESS_MONTHLY,
): Promise<Seeded> {
  const suffix = `${crypto.randomUUID().slice(0, 8)}-${++seq}`
  const ws = await db.workspace.create({
    data: { name: `Seats ${suffix}`, slug: `seats-${suffix}`, kind: 'team' },
  })
  const users = await Promise.all(
    [0, 1, 2].map((n) =>
      db.user.create({ data: { name: `seat-${n}-${suffix}`, email: `seat-${n}-${suffix}@example.com` } }),
    ),
  )
  const members = await Promise.all(
    users.map((u: any, n: number) =>
      db.member.create({
        data: { userId: u.id, workspaceId: ws.id, projectId: null, role: n === 0 ? 'owner' : 'member' },
      }),
    ),
  )
  const now = new Date()
  await db.subscription.create({
    data: {
      workspaceId: ws.id,
      stripeSubscriptionId: `sub_${suffix}`,
      stripeCustomerId: `cus_${suffix}`,
      planId: 'business',
      seats: 3,
      status: 'active',
      billingInterval: 'monthly',
      stripePriceId,
      currentPeriodStart: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      currentPeriodEnd: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000),
    },
  })
  await db.usageWallet.create({
    data: {
      workspaceId: ws.id,
      monthlyIncludedUsd: 0,
      dailyIncludedUsd: 0,
      overageEnabled: false,
      overageAccumulatedUsd: 0,
      anniversaryDay: 1,
      lastDailyReset: now,
      lastMonthlyReset: now,
    },
  })
  return { workspaceId: ws.id, userIds: users.map((u: any) => u.id), memberIds: members.map((m: any) => m.id) }
}

async function memberRow(id: string) {
  return db.member.findUnique({ where: { id } })
}

const spend = (workspaceId: string, memberId: string, billedUsd: number) =>
  billing.consumeUsage({ workspaceId, projectId: null, memberId, actionType: 'chat', billedUsd })

describe('SHO-312 per-seat allowance (real database)', () => {
  test('the migration gives every existing member an empty window', async () => {
    const { memberIds } = await seedPaidWorkspace()
    for (const id of memberIds) {
      const row = await memberRow(id)
      expect(row.fiveHourUsedUsd).toBe(0)
      expect(row.weeklyUsedUsd).toBe(0)
      expect(row.weeklyWindowStart).toBeNull()
    }
  })

  test('one seat exhausting its window blocks only that seat', async () => {
    const { workspaceId, userIds, memberIds } = await seedPaidWorkspace()
    const [a, b] = userIds

    // A spends its whole 5-hour guard ($1.84): allowed, and it lands on A's row.
    const first = await spend(workspaceId, a, BUSINESS_FIVE_HOUR_USD)
    expect(first.success).toBe(true)
    expect(first.source).toBe('window')
    expect((await memberRow(memberIds[0])).fiveHourUsedUsd).toBeCloseTo(BUSINESS_FIVE_HOUR_USD)
    expect((await memberRow(memberIds[0])).weeklyUsedUsd).toBeCloseTo(BUSINESS_FIVE_HOUR_USD)

    // A cent more does not fit the exhausted window: A is blocked, not pooled.
    const blocked = await spend(workspaceId, a, 0.01)
    expect(blocked.success).toBe(false)
    expect(blocked.reason).toBe('usage_limit_reached')

    // B has spent nothing and still has its own full allowance.
    const bFirst = await spend(workspaceId, b, BUSINESS_FIVE_HOUR_USD)
    expect(bFirst.success).toBe(true)
    expect((await memberRow(memberIds[0])).fiveHourUsedUsd).toBeCloseTo(BUSINESS_FIVE_HOUR_USD)

    // A's failed attempt changed nothing; B's spend did not top A up.
    expect((await memberRow(memberIds[1])).fiveHourUsedUsd).toBeCloseTo(BUSINESS_FIVE_HOUR_USD)
    expect((await memberRow(memberIds[2])).fiveHourUsedUsd).toBe(0)
  })

  test('the workspace wallet stays at zero on a paid plan', async () => {
    const { workspaceId, userIds } = await seedPaidWorkspace()
    await spend(workspaceId, userIds[0], 1.0)
    await spend(workspaceId, userIds[1], 1.5)

    const wallet = await db.usageWallet.findUnique({ where: { workspaceId } })
    expect(wallet.weeklyUsedUsd ?? 0).toBe(0)
    expect(wallet.fiveHourUsedUsd ?? 0).toBe(0)
  })

  test('three paying seats do not give one member a 3× allowance', async () => {
    const { workspaceId, userIds } = await seedPaidWorkspace()
    const a = userIds[0]

    // The windows a seat sees are one seat's, even though the workspace pays
    // for three: $1.84 / 5h and $4.60 / week, not those × 3.
    const windows = await billing.getUsageWindows(workspaceId, a)
    expect(windows.fiveHour.limitUsd).toBeCloseTo(BUSINESS_FIVE_HOUR_USD)
    expect(windows.weekly.limitUsd).toBeCloseTo(BUSINESS_WEEKLY_USD)

    // And enforcement agrees with what it reports.
    expect((await spend(workspaceId, a, BUSINESS_FIVE_HOUR_USD)).success).toBe(true)
    const over = await spend(workspaceId, a, BUSINESS_FIVE_HOUR_USD)
    expect(over.success).toBe(false)
    expect(over.reason).toBe('usage_limit_reached')
  })

  test('the usage endpoints answer for the caller’s own seat', async () => {
    const { workspaceId, userIds } = await seedPaidWorkspace()
    const [a, b] = userIds
    await spend(workspaceId, a, 1.5)

    const aWindows = await billing.getUsageWindows(workspaceId, a)
    expect(aWindows.weekly.limitUsd).toBeCloseTo(BUSINESS_WEEKLY_USD)
    expect(aWindows.weekly.usedUsd).toBeCloseTo(1.5)

    const bWindows = await billing.getUsageWindows(workspaceId, b)
    expect(bWindows.weekly.usedUsd).toBe(0)
    expect(bWindows.weekly.limitUsd).toBeCloseTo(BUSINESS_WEEKLY_USD)

    expect((await billing.checkUsageBalance(workspaceId, 0.001, a)).ok).toBe(true)
    expect((await billing.checkUsageBalance(workspaceId, 0.001, b)).ok).toBe(true)
  })

  test('usage with no seat behind it is still metered, against the wallet', async () => {
    const { workspaceId, memberIds } = await seedPaidWorkspace()
    const res = await spend(workspaceId, 'system', 0.25)
    expect(res.success).toBe(true)

    const wallet = await db.usageWallet.findUnique({ where: { workspaceId } })
    expect(wallet.weeklyUsedUsd).toBeCloseTo(0.25)
    for (const id of memberIds) expect((await memberRow(id)).weeklyUsedUsd).toBe(0)
  })

  test('a Business sub with no price keeps the $40 seat allowance until it renews', async () => {
    const { workspaceId, userIds } = await seedPaidWorkspace(null)
    const windows = await billing.getUsageWindows(workspaceId, userIds[0])
    expect(windows.fiveHour.limitUsd).toBeCloseTo(LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS.fiveHourUsd)
    expect(windows.weekly.limitUsd).toBeCloseTo(LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS.weeklyUsd)

    // Same row, after the renewal writes the v2.5.0 price id.
    await db.subscription.updateMany({
      where: { workspaceId },
      data: { stripePriceId: NEW_BUSINESS_MONTHLY },
    })
    const after = await billing.getUsageWindows(workspaceId, userIds[0])
    expect(after.fiveHour.limitUsd).toBeCloseTo(BUSINESS_FIVE_HOUR_USD)
    expect(after.weekly.limitUsd).toBeCloseTo(BUSINESS_WEEKLY_USD)
  })
})
