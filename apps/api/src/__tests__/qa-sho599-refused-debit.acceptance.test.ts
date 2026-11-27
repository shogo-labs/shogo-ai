// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-599, a refused debit still records the provider spend,
 * and the usage gate and the debit follow one rule (card acceptance criteria
 * 1, 3 and 4).
 *
 * Runs the real billing code against a real database (desktop SQLite
 * migrations by default; Postgres with `CHANNELS_TEST_PG_URL`), not against a
 * hand-built wallet mock:
 *
 *   1. **Rule B** — ЄВГЕН's exact state (paid, `firstPaidAt` null, overage on,
 *      $0.40 of window room left): the gate admits, the $3 call is debited to
 *      the last of the room (past the limit), and the *next* gate call is
 *      refused with `overage_requires_payment`. Before the fix the call was
 *      admitted, refused, and the room never moved — forever.
 *   2. A refused debit writes exactly one `usage_events` row with the real
 *      provider cost, `billedUsd` 0, `source: 'refused'` and the reason, while
 *      the wallet counters stay untouched.
 *   3. A free workspace at its window cap gets the same refused row.
 *   4. The billing-session path: a closed session charges its turn, and
 *      `closeSession({ discardPartial: true })` bills nothing but still records
 *      the spend it incurred.
 *
 *   bun test apps/api/src/__tests__/qa-sho599-refused-debit.acceptance.test.ts
 */

import { describe, expect, test } from 'bun:test'

const { setupChannelsTestDb } = await import('./helpers/channels-test-db')
setupChannelsTestDb()

// The helper flags local mode so `lib/prisma` builds a SQLite client; bind it
// first, then clear the flag so the cloud metering path runs (`isLocalMode` is
// captured at import).
const { prisma } = await import('../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

const billing = await import('../services/billing.service')
const session = await import('../lib/proxy-billing-session')
const db = prisma as any

/** usage-plans.ts: Business is $1.84 / 5 h and $4.60 / week per seat. */
const BUSINESS_FIVE_HOUR_USD = 1.84
const BUSINESS_WEEKLY_USD = 4.6
const RULE_B_ROOM_USD = 0.4

let seq = 0

async function seedWorkspace(opts: {
  paid?: boolean
  overageEnabled?: boolean
  fiveHourUsedUsd?: number
  weeklyUsedUsd?: number
} = {}): Promise<{ workspaceId: string; projectId: string; userId: string }> {
  const suffix = `${crypto.randomUUID().slice(0, 8)}-${++seq}`
  const workspace = await db.workspace.create({
    data: { name: `SHO-599 ${suffix}`, slug: `sho599-${suffix}`, kind: 'team' },
  })
  const user = await db.user.create({
    data: { name: `user-${suffix}`, email: `user-${suffix}@example.com` },
  })
  await db.member.create({ data: { userId: user.id, workspaceId: workspace.id, role: 'owner' } })
  const project = await db.project.create({
    data: { name: `project-${suffix}`, workspaceId: workspace.id },
  })

  if (opts.paid) {
    const now = new Date()
    await db.subscription.create({
      data: {
        workspaceId: workspace.id,
        stripeSubscriptionId: `sub_${suffix}`,
        stripeCustomerId: `cus_${suffix}`,
        planId: 'business',
        seats: 1,
        status: 'active',
        billingInterval: 'monthly',
        // A trial that has never paid: `overageTrusted` is false, exactly like
        // ЄВГЕН's workspace, so an exhausted window refuses with
        // `overage_requires_payment` instead of metering overage.
        currentPeriodStart: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000),
      },
    })
  }

  const now = new Date()
  await db.usageWallet.create({
    data: {
      workspaceId: workspace.id,
      monthlyIncludedUsd: 0,
      dailyIncludedUsd: 0,
      overageEnabled: opts.overageEnabled ?? false,
      overageAccumulatedUsd: 0,
      anniversaryDay: 1,
      lastDailyReset: now,
      lastMonthlyReset: now,
      fiveHourWindowStart: now,
      fiveHourUsedUsd: opts.fiveHourUsedUsd ?? 0,
      weeklyWindowStart: now,
      weeklyUsedUsd: opts.weeklyUsedUsd ?? 0,
    },
  })

  return { workspaceId: workspace.id, projectId: project.id, userId: user.id }
}

const rowsFor = (workspaceId: string) =>
  db.usageEvent.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

const walletFor = (workspaceId: string) =>
  db.usageWallet.findUnique({ where: { workspaceId } })

function expectRefusedRow(row: any, reason: string, rawUsd: number) {
  expect(row.source).toBe('refused')
  expect(Number(row.rawUsd)).toBeCloseTo(rawUsd, 6)
  expect(row.billedUsd).toBe(0)
  expect(row.balanceBefore).toBe(0)
  expect(row.balanceAfter).toBe(0)
  expect(row.actionMetadata.refused).toBe(true)
  expect(row.actionMetadata.refusalReason).toBe(reason)
  expect(row.actionMetadata.attemptedBilledUsd).toBeGreaterThan(0)
}

describe('SHO-599 AC3: the gate and the debit agree (real database)', () => {
  test('the last window room absorbs the call, then the gate refuses with overage_requires_payment', async () => {
    const { workspaceId } = await seedWorkspace({
      paid: true,
      overageEnabled: true,
      fiveHourUsedUsd: BUSINESS_FIVE_HOUR_USD - RULE_B_ROOM_USD,
      weeklyUsedUsd: BUSINESS_WEEKLY_USD - RULE_B_ROOM_USD,
    })

    // The state that used to loop: $0.40 of room, a $3 call.
    expect((await billing.checkUsageBalance(workspaceId)).ok).toBe(true)

    const first = await billing.consumeUsage({
      workspaceId,
      projectId: null,
      memberId: 'system',
      actionType: 'ai_proxy_completion',
      rawUsd: 2.75,
      billedUsd: 3,
    })
    expect(first.success).toBe(true)
    expect(first.source).toBe('window')

    const afterFirst = await walletFor(workspaceId)
    expect(afterFirst.fiveHourUsedUsd).toBeCloseTo(BUSINESS_FIVE_HOUR_USD - RULE_B_ROOM_USD + 3, 6)
    expect(afterFirst.weeklyUsedUsd).toBeCloseTo(BUSINESS_WEEKLY_USD - RULE_B_ROOM_USD + 3, 6)

    let rows = await rowsFor(workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source).toBe('window')
    expect(rows[0]!.billedUsd).toBe(3)
    expect(Number(rows[0]!.rawUsd)).toBeCloseTo(2.75, 6)

    // The loop is closed: no room left, and the gate says why.
    expect(await billing.checkUsageBalance(workspaceId)).toEqual({
      ok: false,
      reason: 'overage_requires_payment',
    })

    // The next call is refused by the gate's own rule — and leaves its spend.
    const second = await billing.consumeUsage({
      workspaceId,
      projectId: null,
      memberId: 'system',
      actionType: 'ai_proxy_completion',
      rawUsd: 2.75,
      billedUsd: 3,
    })
    expect(second.success).toBe(false)
    expect(second.reason).toBe('overage_requires_payment')

    rows = await rowsFor(workspaceId)
    expect(rows).toHaveLength(2)
    expectRefusedRow(rows[1], 'overage_requires_payment', 2.75)

    // A refusal is not a debit: nothing moved.
    const afterSecond = await walletFor(workspaceId)
    expect(afterSecond.fiveHourUsedUsd).toBeCloseTo(afterFirst.fiveHourUsedUsd, 6)
    expect(afterSecond.weeklyUsedUsd).toBeCloseTo(afterFirst.weeklyUsedUsd, 6)
    expect(afterSecond.overageAccumulatedUsd).toBe(0)
    expect(afterSecond.overageEnabled).toBe(true)
  })
})

describe('SHO-599 AC1: a refused debit never makes provider spend disappear', () => {
  test('a free workspace at its cap writes one refused row with the real cost', async () => {
    const { workspaceId } = await seedWorkspace({
      overageEnabled: false,
      // Free caps are $0.20 / 5 h and $0.50 / week.
      fiveHourUsedUsd: 0.5,
      weeklyUsedUsd: 2,
    })

    const res = await billing.consumeUsage({
      workspaceId,
      projectId: null,
      memberId: 'system',
      actionType: 'ai_proxy_completion',
      rawUsd: 1.4,
      billedUsd: 1.5,
    })
    expect(res.success).toBe(false)
    expect(res.reason).toBe('usage_limit_reached')

    const rows = await rowsFor(workspaceId)
    expect(rows).toHaveLength(1)
    expectRefusedRow(rows[0], 'usage_limit_reached', 1.4)

    const wallet = await walletFor(workspaceId)
    expect(wallet.fiveHourUsedUsd).toBeCloseTo(0.5, 6)
    expect(wallet.weeklyUsedUsd).toBeCloseTo(2, 6)
  })
})

describe('SHO-599 AC4: the billing-session path follows the same rules (real database)', () => {
  test('a closed session charges its turn exactly once', async () => {
    const { workspaceId, projectId, userId } = await seedWorkspace({ paid: true })

    await session.openSession(projectId, workspaceId, userId, null)
    await session.accumulateUsage(projectId, 'claude-haiku-4-5', 1000, 200, 100, 50)
    const closed = await session.closeSession(projectId, {})
    expect(closed.billedUsd).toBeGreaterThan(0)

    const rows = await rowsFor(workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.billedUsd).toBeCloseTo(closed.billedUsd, 6)
    expect(Number(rows[0]!.rawUsd)).toBeGreaterThan(0)
    expect(rows[0]!.source).not.toBe('refused')
  })

  test('a discarded partial turn bills nothing but records its spend', async () => {
    const { workspaceId, projectId, userId } = await seedWorkspace({ paid: true })

    await session.openSession(projectId, workspaceId, userId, null)
    await session.accumulateUsage(projectId, 'claude-haiku-4-5', 800, 120, 80, 40)
    const closed = await session.closeSession(projectId, { discardPartial: true })
    expect(closed.billedUsd).toBe(0)

    const rows = await rowsFor(workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.billedUsd).toBe(0)
    expect(Number(rows[0]!.rawUsd)).toBeGreaterThan(0)
    expect(rows[0]!.source).toBe('refused')
    expect(rows[0]!.actionMetadata.refusalReason).toBe('discarded_partial')
    expect(rows[0]!.actionMetadata.inputTokens).toBe(800)
    expect(rows[0]!.actionMetadata.outputTokens).toBe(120)

    // Billing nothing means the wallet did not move.
    const wallet = await walletFor(workspaceId)
    expect(wallet.fiveHourUsedUsd).toBe(0)
    expect(wallet.weeklyUsedUsd).toBe(0)
  })

  test('a discarded partial that generated a video records its provider cost once, not twice', async () => {
    const { workspaceId, projectId, userId } = await seedWorkspace({ paid: true })

    await session.openSession(projectId, workspaceId, userId, null)
    await session.accumulateUsage(projectId, 'claude-haiku-4-5', 800, 120, 80, 40)
    // A finished video is charged even when the turn is discarded, in its own
    // row below the discard branch. Its provider cost must not also sit inside
    // the discarded turn's `refused` row (that would double the video's rawUsd
    // in analytics — the mirror of the bug this card fixes).
    await session.accumulateVideoUsage(projectId, 'seedance-2', 5, 2, 2.6)
    const closed = await session.closeSession(projectId, { discardPartial: true })
    expect(closed.billedUsd).toBeCloseTo(2.6, 6)

    const rows = await rowsFor(workspaceId)
    const videoRow = rows.find((r: any) => r.actionType === 'ai_video_generation')
    const refusedRow = rows.find((r: any) => r.source === 'refused')
    expect(videoRow).toBeTruthy()
    expect(refusedRow).toBeTruthy()
    expect(Number(videoRow.rawUsd)).toBeCloseTo(2, 6)
    // Tokens only: the video's $2 lives in its own row.
    expect(Number(refusedRow.rawUsd)).toBeLessThan(0.05)
    const totalRawUsd = rows.reduce((sum: number, r: any) => sum + Number(r.rawUsd), 0)
    expect(totalRawUsd).toBeLessThan(2.05)
  })
})
