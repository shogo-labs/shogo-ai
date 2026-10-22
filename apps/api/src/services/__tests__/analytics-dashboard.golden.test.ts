// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-140 acceptance 6 — the one-scan dashboard returns the *same numbers* the
 * three old read paths returned.
 *
 * The Usage tab used to call `getUsageSummary`, `getSpendTimeseries` and
 * `getUsageAnalytics`, each of which `findMany`d the whole window. It now reads
 * `getUsageDashboard`, which pushes the aggregation into SQL. This file seeds a
 * real SQLite database (the desktop migration track), then asserts the new
 * output equals the old implementations' output on the same rows — a golden
 * fixture that fails if the SQL rewrite drifts.
 *
 * The numbers are compared against the still-present old functions rather than
 * a committed JSON snapshot so both implementations read the same rows in the
 * same run — the comparison breaks the moment either side drifts.
 *
 *   bun test apps/api/src/services/__tests__/analytics-dashboard.golden.test.ts
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const analytics = await import('../analytics.service')
const db = prisma as any

const PERIOD = '30d' as const
const WORKSPACE_SLUG = `usage-golden-${crypto.randomUUID().slice(0, 8)}`

let scope: { workspaceId: string }
let otherScope: { workspaceId: string }
let shapeScope: { workspaceId: string }

/** Deterministic PRNG so the fixture is identical on every run. */
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
  { model: 'claude-sonnet-4-5', provider: 'anthropic', input: 1200, output: 300, cached: 400, cacheWrite: 0 },
  { model: 'gpt-5', provider: 'openai', input: 800, output: 200, cached: 0, cacheWrite: 0 },
  { model: 'hoshi-2-0', provider: 'deepseek', input: 5000, output: 900, cached: 1000, cacheWrite: 120 },
  { model: 'local-unpriced', provider: 'local', input: 100, output: 50, cached: 0, cacheWrite: 0 },
]
const ACTION_TYPES = [
  'ai_proxy_completion',
  'chat_message',
  'voice_minutes_inbound',
  'voice_number_monthly',
  // Outside the metered set: the dashboard's breakdown counts these, the log
  // and summary must not.
  'ai_proxy_internal',
]
const SOURCES = ['daily', 'monthly', 'overage', 'window']

/**
 * Money and ratios are summed in SQL now, so the float result can differ from
 * the old row-by-row JS accumulation in the last bits
 * (`0.10167799999999999` vs `0.10167800000000002`). Counts, sums of integers and
 * every string must match exactly; non-integers are compared with a relative
 * epsilon far tighter than anything either path prints.
 */
function expectSameNumbers(received: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number' && typeof received === 'number') {
    if (Number.isInteger(expected) && Number.isInteger(received)) {
      expect(received, path).toBe(expected)
      return
    }
    const scale = Math.max(1, Math.abs(expected), Math.abs(received))
    const delta = Math.abs(received - expected)
    if (delta > 1e-9 * scale) {
      throw new Error(`${path}: ${received} !== ${expected} (delta ${delta})`)
    }
    return
  }
  if (Array.isArray(expected) || Array.isArray(received)) {
    expect(Array.isArray(received), `${path} is not an array`).toBe(true)
    expect((received as unknown[]).length, `${path} length`).toBe((expected as unknown[]).length)
    ;(expected as unknown[]).forEach((value, i) => {
      expectSameNumbers((received as unknown[])[i], value, `${path}[${i}]`)
    })
    return
  }
  if (expected && typeof expected === 'object') {
    expect(received && typeof received === 'object', `${path} is not an object`).toBe(true)
    const got = received as Record<string, unknown>
    const want = expected as Record<string, unknown>
    expect(Object.keys(got).sort(), `${path} keys`).toEqual(Object.keys(want).sort())
    for (const key of Object.keys(want)) {
      expectSameNumbers(got[key], want[key], `${path}.${key}`)
    }
    return
  }
  expect(received, path).toBe(expected)
}

/**
 * Series order is arbitrary when two series tie on the metric (both
 * implementations sort by value), so the label list is compared as a set.
 */
function withSortedModels<T extends { models: string[] }>(data: T): T {
  return { ...data, models: [...data.models].sort() }
}

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const [alice, bob, carol] = await Promise.all([
    db.user.create({ data: { name: 'Alice', email: `alice-${suffix}@example.com` } }),
    db.user.create({ data: { name: 'Bob', email: `bob-${suffix}@example.com` } }),
    db.user.create({ data: { name: 'Carol', email: `carol-${suffix}@example.com` } }),
  ])
  const workspace = await db.workspace.create({
    data: { name: 'Golden Usage', slug: WORKSPACE_SLUG, kind: 'team' },
  })
  const other = await db.workspace.create({
    data: { name: 'Other Workspace', slug: `${WORKSPACE_SLUG}-other`, kind: 'team' },
  })
  const project = await db.project.create({ data: { name: 'Golden Project', workspaceId: workspace.id } })
  scope = { workspaceId: workspace.id }
  otherScope = { workspaceId: other.id }

  const rand = mulberry32(20261022)
  const members = [alice.id, bob.id, carol.id]
  const now = Date.now()
  const rows: any[] = []

  // ~2k events over the 30-day window, mixed members / models / action types /
  // sources, some covered by quota (billedUsd 0, rawUsd set), one unpriced.
  for (let i = 0; i < 2000; i += 1) {
    const spec = MODELS[Math.floor(rand() * MODELS.length)]
    const actionType = ACTION_TYPES[Math.floor(rand() * ACTION_TYPES.length)]
    const source = SOURCES[Math.floor(rand() * SOURCES.length)]
    const memberId = members[Math.floor(rand() * members.length)]
    // Strictly inside the window and never in the future.
    const createdAt = new Date(now - Math.floor(rand() * 29 * 24 * 60 * 60 * 1000) - 60_000)
    const billed = rand() < 0.55 ? 0 : Math.round(rand() * 4000) / 1_000_000
    const rawUsd = rand() < 0.2 ? null : Math.round(rand() * 5000) / 1_000_000
    const totalTokens = spec.input + spec.output + spec.cached + spec.cacheWrite

    rows.push({
      workspaceId: workspace.id,
      projectId: rand() < 0.7 ? project.id : null,
      memberId,
      actionType,
      source,
      billedUsd: billed,
      rawUsd,
      balanceBefore: 0,
      balanceAfter: 0,
      createdAt,
      actionMetadata: {
        model: spec.model,
        provider: spec.provider,
        inputTokens: spec.input,
        outputTokens: spec.output,
        cachedInputTokens: spec.cached,
        cacheWriteTokens: spec.cacheWrite,
        totalTokens,
        durationMs: 1200,
        ...(spec.model === 'local-unpriced' ? { pricingUnknown: true } : {}),
      },
    })
  }

  // A handful for a different workspace — the scope filter must exclude them.
  for (let i = 0; i < 25; i += 1) {
    rows.push({
      workspaceId: other.id,
      projectId: null,
      memberId: alice.id,
      actionType: 'ai_proxy_completion',
      source: 'daily',
      billedUsd: 0.01,
      rawUsd: 0.01,
      balanceBefore: 0,
      balanceAfter: 0,
      createdAt: new Date(now - i * 60_000),
      actionMetadata: { model: 'claude-sonnet-4-5', inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    })
  }

  // Two shapes the loop above can never produce, because every row it seeds
  // carries both the `rawUsd` column and a `totalTokens` field — which is
  // exactly why the fixture missed the under-counted money and the chart's
  // token fallback:
  //  - rows whose cost is only inside `actionMetadata` (`rawUsd`, or the older
  //    `dollarCost`) with a NULL column, as the AI-proxy paths write them, and
  //    one whose cost is column-only, as `live-session-meter` writes it;
  //  - completions with no `totalTokens` field, where the chart reports the
  //    recorded field only while the summary derives input + output.
  // They live in their own workspace so the expected totals below are exact.
  const shapeWorkspace = await db.workspace.create({
    data: { name: 'Shaped Usage', slug: `${WORKSPACE_SLUG}-shapes`, kind: 'team' },
  })
  shapeScope = { workspaceId: shapeWorkspace.id }
  const shapeRows: any[] = [
    {
      memberId: alice.id,
      billedUsd: 0,
      rawUsd: null,
      meta: { model: 'claude-sonnet-4-5', provider: 'anthropic', rawUsd: 0.0088657, inputTokens: 900, outputTokens: 100, totalTokens: 1000 },
    },
    {
      memberId: bob.id,
      billedUsd: 0,
      rawUsd: null,
      meta: { model: 'gpt-5', provider: 'openai', dollarCost: 0.01030257, inputTokens: 400, outputTokens: 60, totalTokens: 460 },
    },
    {
      memberId: alice.id,
      billedUsd: 0,
      rawUsd: 0.004,
      meta: { model: 'hoshi-2-0', provider: 'deepseek', inputTokens: 300, outputTokens: 40, totalTokens: 340 },
    },
    {
      memberId: carol.id,
      billedUsd: 0.002,
      rawUsd: null,
      meta: { model: 'claude-sonnet-4-5', provider: 'anthropic', inputTokens: 700, outputTokens: 130, cachedInputTokens: 90 },
    },
    {
      memberId: carol.id,
      billedUsd: 0,
      rawUsd: null,
      meta: { model: 'gpt-5', provider: 'openai', inputTokens: 250, outputTokens: 25 },
    },
  ]
  shapeRows.forEach((row, i) => {
    rows.push({
      workspaceId: shapeWorkspace.id,
      projectId: null,
      memberId: row.memberId,
      actionType: 'ai_proxy_completion',
      source: 'daily',
      billedUsd: row.billedUsd,
      rawUsd: row.rawUsd,
      balanceBefore: 0,
      balanceAfter: 0,
      createdAt: new Date(now - 3_600_000 - i * 1000),
      actionMetadata: row.meta,
    })
  })

  await db.usageEvent.createMany({ data: rows })

  // Tool calls, one of them on a workspace-scoped session (no project) — the
  // row the old project-only join dropped.
  const workspaceSession = await db.chatSession.create({
    data: {
      inferredName: 'workspace chat',
      contextType: 'workspace',
      workspaceId: workspace.id,
      createdByUserId: alice.id,
      createdAt: new Date(now - 60_000),
    },
  })
  const projectSession = await db.chatSession.create({
    data: {
      inferredName: 'project chat',
      contextType: 'project',
      contextId: project.id,
      createdAt: new Date(now - 120_000),
    },
  })
  await db.toolCallLog.createMany({
    data: [
      {
        chatSessionId: workspaceSession.id,
        messageId: `msg-${suffix}-1`,
        toolName: 'write_file',
        status: 'complete',
        userId: alice.id,
        createdAt: new Date(now - 60_000),
      },
      {
        chatSessionId: projectSession.id,
        messageId: `msg-${suffix}-2`,
        toolName: 'read_file',
        status: 'complete',
        userId: bob.id,
        createdAt: new Date(now - 120_000),
      },
    ],
  })
})

describe('getUsageDashboard matches the pre-change read paths', () => {
  test('summary rows, totals and pagination equal getUsageSummary', async () => {
    const [dashboard, legacy] = await Promise.all([
      analytics.getUsageDashboard(scope, { period: PERIOD, page: 1, limit: 50 }),
      analytics.getUsageSummary(scope, PERIOD, { page: 1, limit: 50 }),
    ])

    expect(dashboard.summary.total).toBe(legacy.total)
    expect(dashboard.summary.total).toBeGreaterThan(0)
    expectSameNumbers(dashboard.summary.summaries, legacy.summaries)

    const { totalToolCalls: newToolCalls, ...newTotals } = dashboard.summary.totals
    const { totalToolCalls: _oldToolCalls, ...oldTotals } = legacy.totals
    expectSameNumbers(newTotals, oldTotals)
    // Acceptance 6: the only number that moves is tool calls, and it moves up
    // because workspace-scoped sessions are now counted — the old where clause
    // joined only `chatSession.project.workspaceId`.
    const legacyToolCalls = await db.toolCallLog.count({
      where: {
        status: 'complete',
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        chatSession: { project: { workspaceId: scope.workspaceId } },
      },
    })
    expect(legacyToolCalls).toBe(1)
    expect(newToolCalls).toBe(2)
  })

  /**
   * QA round 3: `totalRawUsd` must include rows whose cost lives only in
   * `actionMetadata`. The desktop renders this column as its cost, so a
   * column-only `SUM("rawUsd")` silently showed less money than was spent.
   */
  test('totalRawUsd counts the cost recorded only in actionMetadata', async () => {
    const [dashboard, legacy] = await Promise.all([
      analytics.getUsageDashboard(shapeScope, { period: PERIOD, page: 1, limit: 50 }),
      analytics.getUsageSummary(shapeScope, PERIOD, { page: 1, limit: 50 }),
    ])
    // 0.0088657 via metadata `rawUsd` + 0.01030257 via metadata `dollarCost` +
    // 0.004 recorded only on the column + the billed-only row's NULL column.
    expect(legacy.totals.totalRawUsd).toBeCloseTo(0.02316827, 9)
    expectSameNumbers(dashboard.summary.summaries, legacy.summaries)
    expect(dashboard.summary.totals.totalRawUsd).toBeCloseTo(legacy.totals.totalRawUsd, 9)
  })

  /**
   * QA round 3: the chart's `tokens` metric has always read the recorded
   * `totalTokens` field, so a completion without one contributes 0 there even
   * though the summary derives input + output. The grouped scan must not apply
   * the summary's fallback to the chart.
   */
  test('the tokens chart ignores rows with no totalTokens field, like getSpendTimeseries', async () => {
    const [dashboard, legacy] = await Promise.all([
      analytics.getUsageDashboard(shapeScope, { period: PERIOD, metric: 'tokens' }),
      analytics.getSpendTimeseries(shapeScope, PERIOD, { metric: 'tokens' }),
    ])
    expectSameNumbers(withSortedModels(dashboard.timeseries), withSortedModels(legacy))

    const chartTokens = dashboard.timeseries.days.reduce((s: number, d: any) => s + d.total, 0)
    expect(chartTokens).toBe(1000 + 460 + 340)
    const summary = await analytics.getUsageDashboard(shapeScope, { period: PERIOD })
    // The two completions without a `totalTokens` field contribute 700+130+90
    // and 250+25 to the summary and nothing to the chart.
    expect(summary.summary.totals.totalTokens - chartTokens).toBe(1195)
  })


  test('a second summary page equals the legacy page', async () => {
    const [dashboard, legacy] = await Promise.all([
      analytics.getUsageDashboard(scope, { period: PERIOD, page: 2, limit: 3 }),
      analytics.getUsageSummary(scope, PERIOD, { page: 2, limit: 3 }),
    ])
    expectSameNumbers(dashboard.summary.summaries, legacy.summaries)
  })

  test('the spend timeseries equals getSpendTimeseries for every grouping and metric', async () => {
    for (const groupBy of ['model', 'user', 'source'] as const) {
      for (const metric of ['spend', 'tokens', 'requests'] as const) {
        const [dashboard, legacy] = await Promise.all([
          analytics.getUsageDashboard(scope, { period: PERIOD, groupBy, metric }),
          analytics.getSpendTimeseries(scope, PERIOD, { groupBy, metric }),
        ])
        // Series order is arbitrary when two series tie on the metric (the seed
        // produces one), so compare the labels as a set.
        expectSameNumbers(withSortedModels(dashboard.timeseries), withSortedModels(legacy))
      }
    }
  })

  test('the breakdown equals getUsageAnalytics', async () => {
    const [dashboard, legacy] = await Promise.all([
      analytics.getUsageDashboard(scope, { period: PERIOD }),
      analytics.getUsageAnalytics(scope, PERIOD),
    ])
    expectSameNumbers(dashboard.usage, legacy)
  })

  test('logCount counts the metered events in the window, like the log total', async () => {
    const [dashboard, log] = await Promise.all([
      analytics.getUsageDashboard(scope, { period: PERIOD }),
      analytics.getUsageLog(scope, PERIOD, { page: 1, limit: 50 }),
    ])
    expect(dashboard.logCount).toBe(log.total)
  })

  test('a member scope only sees their own rows, and a second workspace never leaks in', async () => {
    const memberScope = { ...scope, userId: (await db.user.findFirst({ where: { name: 'Alice' } })).id }
    const [dashboard, legacy] = await Promise.all([
      analytics.getUsageDashboard(memberScope, { period: PERIOD }),
      analytics.getUsageSummary(memberScope, PERIOD, { page: 1, limit: 50 }),
    ])
    expectSameNumbers(dashboard.summary.summaries, legacy.summaries)
    expect(dashboard.summary.summaries.every((row: any) => row.userId === memberScope.userId)).toBe(true)

    const otherDashboard = await analytics.getUsageDashboard(otherScope, { period: PERIOD })
    expect(otherDashboard.summary.totals.totalRequests).toBe(25)
    expect(dashboard.summary.totals.totalRequests).toBeLessThan(2_000)
  })
})
