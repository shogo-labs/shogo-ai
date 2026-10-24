// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The cloud half of SHO-140's scan, checked in CI.
//
// Every other test file in this package runs with SHOGO_LOCAL_MODE=true (desktop
// SQLite). Deleting it before the dynamic import loads the module with
// SQLite off, so `getUsageDashboard` takes the Postgres branch and builds the
// `jsonb` aggregation. Nothing here executes it — the statement is captured —
// but the properties that can silently regress are all shape:
//
//   * one statement per dashboard request, not one per shape;
//   * the JSON is read by `jsonb` operators *inside* the aggregation, and
//     `actionMetadata` is never selected as a column (acceptance 2: no JSON
//     crossing the wire);
//   * every placeholder is bound (no interpolated values) and the parameters
//     arrive in the same order as the `$n`s;
//   * Postgres returns `numeric` aggregates as strings, so the row mapping has
//     to coerce.

import { beforeEach, describe, expect, test, mock } from 'bun:test'

delete process.env.SHOGO_LOCAL_MODE

const captured: Array<{ sql: string; params: unknown[] }> = []

const mockPrisma = {
  $queryRawUnsafe: mock((sql: string, ...params: unknown[]) => {
    captured.push({ sql, params })
    return Promise.resolve([] as unknown[])
  }),
  user: { findMany: mock(() => Promise.resolve([])) },
  toolCallLog: { count: mock(() => Promise.resolve(0)) },
  usageEvent: { findMany: mock(() => Promise.resolve([])) },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma, default: mockPrisma }))
mock.module('../services/model-registry.service', () => ({
  resolveModelLabels: async () => new Map<string, string>(),
}))

const { getUsageDashboard } = await import('../services/analytics.service')
const { clearAnalyticsCache } = await import('../lib/analytics-cache')

beforeEach(() => {
  captured.length = 0
  clearAnalyticsCache()
})

const window = { period: '30d' as const }

describe('getUsageDashboard on Postgres', () => {
  test('issues one statement and never selects actionMetadata', async () => {
    await getUsageDashboard({ workspaceId: 'ws_1' }, window)

    expect(captured).toHaveLength(1)
    const [{ sql }] = captured
    expect(sql).toContain('GROUP BY')
    expect(sql).toContain('DATE_TRUNC')
    // The JSON is read by the aggregation: this is what stops ~42 MB of JSONB
    // per scan from being transported to Node.
    expect(sql).toContain('jsonb_typeof("actionMetadata"')
    // ...but the column itself is never part of the projection.
    expect(sql).not.toMatch(/SELECT[\s\S]*?["']actionMetadata["']\s+AS/i)
    expect(sql).not.toMatch(/\bSELECT\s+"actionMetadata"/i)
    // The unmetered rows are dropped in JS, so the scan must not filter on them
    // (the summary and the breakdown need every action type in the window).
    expect(sql).not.toContain('actionType IN')
  })

  test('binds every value it filters on, in placeholder order', async () => {
    await getUsageDashboard({ workspaceId: 'ws_1', projectId: 'p_1', userId: 'u_1' }, window)

    const [{ sql, params }] = captured
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
    expect(placeholders.length).toBeGreaterThan(0)
    // No gaps and nothing re-used: $1..$n, one per bound value.
    expect([...new Set(placeholders)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: params.length }, (_, i) => i + 1),
    )
    // Scope first, then the window — the order the SQL is assembled in.
    expect(params.slice(0, 3)).toEqual(['ws_1', 'p_1', 'u_1'])
    expect(params[3]).toBeInstanceOf(Date)
    expect(params[4]).toBeInstanceOf(Date)
    // Nothing is interpolated into the statement text.
    expect(sql).not.toContain('ws_1')
    expect(sql).not.toContain('p_1')
  })

  test('coerces the strings Postgres returns for numeric aggregates', async () => {
    mockPrisma.$queryRawUnsafe.mockImplementationOnce(() => Promise.resolve([{
      day: new Date('2026-10-01T00:00:00Z'),
      memberId: 'u_1',
      actionType: 'ai_proxy_completion',
      source: 'daily',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      // `SUM(...)` over `numeric` comes back as a string on Postgres.
      requests: '12',
      billedUsd: '0.025',
      rawUsd: '0.020',
      metaRawUsd: '0.020',
      costUsd: '0.025',
      inputTokens: '1200',
      outputTokens: '300',
      totalTokens: '1500',
      totalTokensField: '1500',
      cachedInputTokens: '400',
      cacheWriteTokens: '0',
      durationMs: '10800',
      unpricedRequests: '0',
    }]))

    const data = await getUsageDashboard({ workspaceId: 'ws_1' }, window)

    expect(data.summary.totals.totalRequests).toBe(12)
    expect(data.summary.totals.totalTokens).toBe(1500)
    expect(data.summary.totals.totalBilledUsd).toBeCloseTo(0.025, 9)
    expect(data.summary.summaries[0].avgDurationMs).toBe(900)
    expect(data.logCount).toBe(12)
  })

  test('a day returned as a timestamp string still buckets by UTC day', async () => {
    mockPrisma.$queryRawUnsafe.mockImplementationOnce(() => Promise.resolve([{
      day: '2026-10-01 00:00:00+00',
      memberId: 'u_1',
      actionType: 'ai_proxy_completion',
      source: 'daily',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      requests: 1,
      billedUsd: 0,
      rawUsd: 0,
      metaRawUsd: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensField: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      unpricedRequests: 0,
    }]))

    const data = await getUsageDashboard(
      { workspaceId: 'ws_1' },
      {
        period: '7d',
        fromIso: '2026-09-30T00:00:00.000Z',
        toIso: '2026-10-03T00:00:00.000Z',
        metric: 'requests',
      },
    )
    const first = data.timeseries.days.find((d) => d.date === '2026-10-01')
    expect(first).toBeDefined()
    expect(first?.total).toBe(1)
  })
})
