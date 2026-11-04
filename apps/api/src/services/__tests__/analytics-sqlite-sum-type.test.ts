// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics money sums must never lose their fraction (SHO-336).
 *
 * SHO-311 moved `getSpendTimeseries` (and `getQualityTimeseries`) onto one
 * grouped raw statement per shape: `COALESCE(SUM(<cost CASE>), 0) AS "spend"
 * … GROUP BY 1, 2`. On SQLite `SUM` returns an INTEGER when every row of a
 * group lands on the CASE's integer `0` fallback, and Prisma's SQLite driver
 * types each raw result column from the first row it sees — so one zero-spend
 * group at the top of the result turned every later fractional spend into
 * `0n`, and the whole Usage chart read `$0`.
 *
 * The fixture is deliberately clock-independent: the *earliest* day/model
 * group in the window always has zero cost (included quota / local rows), the
 * later days always carry fractions. `sumReal` renders `TOTAL(...)` on SQLite
 * (always a float) and `COALESCE(SUM(...), 0)` on Postgres.
 *
 *   cd apps/api && bun --no-env-file test ./src/services/__tests__/analytics-sqlite-sum-type.test.ts
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'
import { pinClockIntoCacheBucket, restoreClock } from '../../__tests__/helpers/analytics-bucket'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const analytics = await import('../analytics.service')
const db = prisma as any

const DAY_MS = 24 * 60 * 60 * 1000

/** Day keys the assertions use, filled in `beforeAll` from the pinned clock. */
let zeroDay = ''
let paidDay = ''
/** Fractional spend seeded on `paidDay`, per model. */
const PAID_A = 0.00041475
const PAID_B = 0.00010025
const PAID_TOTAL = PAID_A + PAID_B

/** UTC midnight-ish of the day `daysAgo` days before `now`. */
function dayAt(now: number, daysAgo: number): Date {
  const d = new Date(now - daysAgo * DAY_MS)
  d.setUTCHours(12, 0, 0, 0)
  return d
}

const isoDayOf = (d: Date) => d.toISOString().slice(0, 10)

let workspaceId = ''
let memberId = ''

beforeAll(async () => {
  pinClockIntoCacheBucket()
  const now = Date.now()
  zeroDay = isoDayOf(dayAt(now, 5))
  paidDay = isoDayOf(dayAt(now, 3))

  const suffix = crypto.randomUUID().slice(0, 8)
  const workspace = await db.workspace.create({
    data: { name: 'SHO-336', slug: `sho-336-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  const user = await db.user.create({
    data: { name: 'sho336', email: `sho336-${suffix}@example.com` },
  })
  memberId = user.id

  const base = {
    workspaceId,
    projectId: null,
    memberId,
    actionType: 'ai_proxy_completion',
    source: 'daily',
    balanceBefore: 0,
    balanceAfter: 0,
  }

  await db.usageEvent.createMany({
    data: [
      // The earliest group in the window: covered by included quota / local,
      // no recorded provider cost anywhere. Its CASE evaluates to the integer
      // `0`, which is what used to type the whole `spend` column as int64.
      {
        ...base,
        billedUsd: 0,
        rawUsd: null,
        createdAt: dayAt(now, 5),
        actionMetadata: { model: 'free-local-model', provider: 'local', totalTokens: 0 },
      },
      // Fractional spend, later in the window — must survive.
      {
        ...base,
        billedUsd: PAID_A,
        rawUsd: PAID_A,
        createdAt: dayAt(now, 3),
        actionMetadata: { model: 'paid-model-a', provider: 'anthropic', totalTokens: 1200 },
      },
      {
        ...base,
        billedUsd: PAID_B,
        rawUsd: PAID_B,
        createdAt: new Date(dayAt(now, 3).getTime() + 3_600_000),
        actionMetadata: { model: 'paid-model-b', provider: 'openai', totalTokens: 800 },
      },
    ],
  })
}, 60_000)

afterEach(() => restoreClock())

describe('SHO-336: SQLite SUM of a money column keeps its fraction', () => {
  test('getSpendTimeseries: a zero-spend first group does not zero the window', async () => {
    const data = await analytics.getSpendTimeseries(
      { workspaceId },
      '30d',
      { groupBy: 'model', metric: 'spend' },
    )

    const paid = data.days.find((d) => d.date === paidDay)
    expect(paid).toBeDefined()
    // Per day, and per model: both must be the seeded fractions, not 0.
    expect(paid!.total).toBeCloseTo(PAID_TOTAL, 12)
    const byModelSum = Object.values(paid!.byModel).reduce((sum, v) => sum + v, 0)
    expect(byModelSum).toBeCloseTo(PAID_TOTAL, 12)

    const zero = data.days.find((d) => d.date === zeroDay)
    expect(zero!.total).toBe(0)

    // The chart and the totals row are the same money.
    expect(data.totals.totalSpendUsd).toBeCloseTo(PAID_TOTAL, 12)
  })

  test('getSpendTimeseries: a zero-token first group does not zero the token series', async () => {
    const data = await analytics.getSpendTimeseries(
      { workspaceId },
      '30d',
      { groupBy: 'model', metric: 'tokens' },
    )
    const paid = data.days.find((d) => d.date === paidDay)
    expect(paid!.total).toBe(2000)
  })

  test('getQualityTimeseries: the spend behind costPerActiveUser keeps its fraction', async () => {
    const days = await analytics.getQualityTimeseries({ workspaceId }, '30d')
    const paid = days.find((d) => d.date === paidDay)
    expect(paid).toBeDefined()
    // One active member carries the whole day, so the per-user cost is the
    // day's spend — the value the bug collapsed to 0.
    expect(paid!.costPerActiveUser).toBeCloseTo(PAID_TOTAL, 12)
    const zero = days.find((d) => d.date === zeroDay)
    expect(zero!.costPerActiveUser).toBe(0)
  })
})
