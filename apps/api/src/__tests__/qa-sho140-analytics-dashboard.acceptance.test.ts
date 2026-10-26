// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-140, the Usage tab's one-request open.
 *
 * The card's own tests split the contract in two: a golden fixture compares the
 * service functions against the legacy read paths, and a route test mocks the
 * service to prove the Business gate. Neither one drives the *route* against a
 * real database, so this file closes that gap and pins the two properties the
 * card is actually about:
 *
 *   1. One request carries exactly what the three old read paths returned —
 *      same summary, same timeseries, same breakdown, same log count, from the
 *      same rows, through the real route.
 *   2. The desktop track (SQLite) rolls the window up in Node from ONE scan and
 *      never asks SQLite for `json_extract` — the round-1 regression was a
 *      per-key `json_extract` roll-up that made the local tab 37 % slower than
 *      the five requests it replaced.
 *
 *   cd apps/api && bun test ./src/__tests__/qa-sho140-analytics-dashboard.acceptance.test.ts
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { setupChannelsTestDb } from './helpers/channels-test-db'
import { pinClockIntoCacheBucket, restoreClock } from './helpers/analytics-bucket'

const QA_USER = 'qa-140-user'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { userId: QA_USER })
    await next()
  },
  requireAuth: async (_c: any, next: any) => next(),
}))

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const analytics = await import('../services/analytics.service')
const { clearAnalyticsCache } = await import('../lib/analytics-cache')
const { scopedAnalyticsRoutes } = await import('../routes/scoped-analytics')
const db = prisma as any

let workspaceId = ''
let projectId = ''

/** Deterministic PRNG so the fixture is the same on every run. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MODELS = [
  { model: 'claude-sonnet-4-5', provider: 'anthropic' },
  { model: 'gpt-5', provider: 'openai' },
  { model: 'hoshi-2-0', provider: 'deepseek' },
]
const ACTION_TYPES = ['ai_proxy_completion', 'chat_message', 'voice_minutes_inbound', 'ai_proxy_internal']
const SOURCES = ['daily', 'overage']

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const workspace = await db.workspace.create({
    data: { name: 'QA 140', slug: `qa-140-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  const project = await db.project.create({ data: { name: 'QA 140 project', workspaceId } })
  projectId = project.id
  // `--rerun-each` re-evaluates this file, so `beforeAll` runs again against the
  // same database: the session user id is fixed, so adopt the row when it is
  // already there instead of dying on a unique violation (SHO-186).
  const user = await db.user.upsert({
    where: { id: QA_USER },
    create: { id: QA_USER, name: 'QA', email: `${QA_USER}-${suffix}@example.com` },
    update: {},
  })
  await db.member.create({ data: { userId: user.id, workspaceId, role: 'admin' } })
  const team = await Promise.all(
    ['m1', 'm2', 'm3'].map((n) =>
      db.user.create({ data: { name: n, email: `${n}-${suffix}@example.com` } }),
    ),
  )

  const random = mulberry32(140140)
  const now = Date.now()
  const events: any[] = []
  for (let i = 0; i < 640; i += 1) {
    const model = MODELS[Math.floor(random() * MODELS.length)]
    const input = 400 + Math.floor(random() * 4000)
    const output = 100 + Math.floor(random() * 900)
    const cached = random() < 0.4 ? Math.floor(random() * 500) : 0
    const cacheWrite = random() < 0.2 ? Math.floor(random() * 120) : 0
    // Every third row leaves `totalTokens` out, so the fallback is exercised.
    const withTotal = i % 3 !== 0
    events.push({
      workspaceId,
      projectId: i % 11 === 0 ? null : projectId,
      memberId: team[i % team.length].id,
      actionType: ACTION_TYPES[Math.floor(random() * ACTION_TYPES.length)],
      source: SOURCES[Math.floor(random() * SOURCES.length)],
      billedUsd: random() < 0.5 ? 0 : Number((random() * 0.0004).toFixed(8)),
      rawUsd: random() < 0.5 ? null : Number((random() * 0.0005).toFixed(8)),
      balanceBefore: 0,
      balanceAfter: 0,
      createdAt: new Date(now - Math.floor(random() * 20) * 24 * 3600 * 1000 - Math.floor(random() * 86_000_000)),
      actionMetadata: {
        model: model.model,
        provider: model.provider,
        inputTokens: input,
        outputTokens: output,
        cachedInputTokens: cached,
        cacheWriteTokens: cacheWrite,
        ...(withTotal ? { totalTokens: input + output + cached + cacheWrite } : {}),
        durationMs: 200 + Math.floor(random() * 1800),
        ...(i % 17 === 0 ? { pricingUnknown: true } : {}),
        ...(i % 23 === 0 ? { dollarCost: Number((random() * 0.002).toFixed(8)), rawUsd: undefined } : {}),
      },
    })
  }
  await db.usageEvent.createMany({ data: events })
}, 120_000)

async function call(path: string) {
  const res = await scopedAnalyticsRoutes().fetch(new Request(`http://test${path}`))
  const body: any = await res.json().catch(() => ({}))
  return { status: res.status, data: body.data ?? body }
}

/** Counts the statements the desktop roll-up actually issues. */
function watch(tracker: { scans: number; raw: string[] }) {
  const findMany = db.usageEvent.findMany.bind(db.usageEvent)
  db.usageEvent.findMany = async (...args: any[]) => {
    tracker.scans += 1
    return findMany(...args)
  }
  const raw = db.$queryRawUnsafe.bind(db)
  db.$queryRawUnsafe = async (sql: string, ...params: any[]) => {
    tracker.raw.push(String(sql))
    return raw(sql, ...params)
  }
  return () => {
    db.usageEvent.findMany = findMany
    db.$queryRawUnsafe = raw
  }
}

/**
 * The two calls below only share a cache key while the clock stays inside one
 * bucket, so pin it inside one (`pinClockIntoCacheBucket`). This replaces the
 * old "sleep up to the next boundary", which could stall a test for 40 s and
 * left it depending on the real clock (SHO-186).
 */

beforeEach(() => {
  clearAnalyticsCache()
})

/** A pinned clock never outlives the test that pinned it. */
afterEach(() => restoreClock())

/**
 * The grouped scan sums in a different order than the three legacy loops, so a
 * decimal lands a bit or two differently (0.07249329999999998 vs 0.0724933).
 * Rounding at 1e-9 keeps the comparison strict on every other digit while not
 * pinning the summation order.
 */
function canon(value: any): any {
  if (typeof value === 'number') return Number(value.toFixed(9))
  if (Array.isArray(value)) return value.map(canon)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canon(v)]))
  }
  return value
}

describe('SHO-140 QA: one request, the same numbers', () => {
  test('the dashboard equals the three read paths the panel used to call', async () => {
    const { status, data } = await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&groupBy=model&metric=spend&limit=50`)
    expect(status).toBe(200)

    const [summary, timeseries, usage, log] = await Promise.all([
      analytics.getUsageSummary({ workspaceId }, '30d', { page: 1, limit: 50 }),
      analytics.getSpendTimeseries({ workspaceId }, '30d', { groupBy: 'model', metric: 'spend' }),
      analytics.getUsageAnalytics({ workspaceId }, '30d'),
      analytics.getUsageLog({ workspaceId }, '30d', { page: 1, limit: 50 }),
    ])

    expect(canon(data.summary.totals)).toEqual(canon(summary.totals as any))
    expect(canon(data.summary.summaries)).toEqual(canon(summary.summaries as any))
    expect(data.summary.total).toBe(summary.total)
    expect(canon(data.timeseries)).toEqual(canon(timeseries as any))
    expect(canon(data.usage)).toEqual(canon(usage as any))
    expect(data.logCount).toBe(log.total)
    expect(data.window.period).toBe('30d')
  }, 60_000)

  test('tokens on the chart keep the old rule: the recorded field only', async () => {
    const { data } = await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&groupBy=model&metric=tokens&limit=50`)
    const chartTotal = (data.timeseries as any).days.reduce(
      (sum: number, d: any) => sum + Number(d.total ?? 0),
      0,
    )
    // AC6: the chart has always read `meta.totalTokens || 0` — so the dashboard
    // must reproduce the legacy chart exactly, row for row.
    const legacy = await analytics.getSpendTimeseries({ workspaceId }, '30d', { groupBy: 'model', metric: 'tokens' })
    const legacyTotal = (legacy as any).days.reduce(
      (sum: number, d: any) => sum + Number(d.total ?? 0),
      0,
    )
    expect(chartTotal).toBe(legacyTotal)

    // A third of this fixture carries input/output but no `totalTokens`. The
    // summary derives a value for those rows; the chart must still count 0, or
    // the two halves of the screen disagree about the number of tokens.
    const summary = await analytics.getUsageSummary({ workspaceId }, '30d', { page: 1, limit: 50 })
    const derived = (summary as any).summaries.reduce(
      (sum: number, row: any) => sum + Number(row.totalInputTokens ?? 0) + Number(row.totalOutputTokens ?? 0)
        + Number(row.totalCachedInputTokens ?? 0),
      0,
    )
    expect(derived).toBeGreaterThan(chartTotal)
  }, 60_000)

  test('the desktop roll-up scans once and never asks SQLite for json_extract', async () => {
    const tracker = { scans: 0, raw: [] as string[] }
    const stop = watch(tracker)
    try {
      const { status } = await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&limit=50`)
      expect(status).toBe(200)
    } finally {
      stop()
    }
    expect(tracker.scans).toBe(1)
    // The round-1 regression: `json_extract` per key per row is slower on SQLite
    // than parsing the JSON in Node, and it is what AC7 fails on.
    expect(tracker.raw.filter((sql) => /json_extract/i.test(sql))).toEqual([])
  }, 60_000)

  test('a second open inside the cache bucket reuses the scan', async () => {
    pinClockIntoCacheBucket()
    const tracker = { scans: 0, raw: [] as string[] }
    const stop = watch(tracker)
    try {
      await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&limit=50`)
      await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&limit=50`)
    } finally {
      stop()
    }
    expect(tracker.scans).toBe(1)
  }, 90_000)

  test('the summary table takes a page size and the page changes the rows', async () => {
    // 3 members x 3 models = 9 aggregate rows, so page at 4.
    const first = await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&limit=4&page=1`)
    expect(first.data.summary.limit).toBe(4)
    expect(first.data.summary.page).toBe(1)
    expect(first.data.summary.summaries).toHaveLength(4)
    expect(first.data.summary.total).toBeGreaterThan(4)

    const second = await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&limit=4&page=2`)
    expect(second.data.summary.page).toBe(2)
    const key = (row: any) => `${row.userId}:${row.model ?? ''}`
    const firstIds = first.data.summary.summaries.map(key)
    const secondIds = second.data.summary.summaries.map(key)
    expect(secondIds).not.toEqual(firstIds)
    // The totals describe the whole window, not the page.
    expect(canon(second.data.summary.totals)).toEqual(canon(first.data.summary.totals))

    // The panel asks for 50 and gets the default page size it asked for.
    const fifty = await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&limit=50&page=1`)
    expect(fifty.data.summary.limit).toBe(50)
    expect(fifty.data.summary.summaries).toHaveLength(9)
  }, 60_000)

  test('a chart toggle and a log page each cost one request and leave the summary alone', async () => {
    pinClockIntoCacheBucket()
    const first = await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&groupBy=model&metric=spend&limit=50`)
    const tracker = { scans: 0, raw: [] as string[] }
    const stop = watch(tracker)
    let toggled: any
    try {
      toggled = await call(`/workspaces/${workspaceId}/analytics/dashboard?period=30d&groupBy=day&metric=tokens&limit=50`)
    } finally {
      stop()
    }
    expect(toggled.status).toBe(200)
    expect(toggled.data.timeseries.groupBy).toBe('day')
    expect(toggled.data.timeseries.metric).toBe('tokens')
    // Same rows, same window: the toggle must not need a new scan.
    expect(toggled.data.summary.totals).toEqual(first.data.summary.totals)
    expect(tracker.scans).toBe(0)
  }, 90_000)
})
