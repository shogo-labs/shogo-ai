// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-311 — the cloud half of the analytics rollups, checked in CI.
 *
 * Every other test file in this package runs with `SHOGO_LOCAL_MODE=true`. This
 * one deletes it before the dynamic import, so the module builds the Postgres
 * dialect: `jsonb` predicates, `TO_CHAR` day buckets, `$n` placeholders.
 *
 * Nothing here executes the statements (that needs a real server — the golden
 * fixture covers the numbers, and runs against Postgres when
 * `CHANNELS_TEST_PG_URL` is set). What it does pin down are the properties that
 * can silently regress into a 40-second page:
 *
 *   * `getToolCallAnalytics` never projects `result`, and its failure rule is a
 *     `jsonb` predicate — the 754 MB read the card was filed about;
 *   * every rewritten read is one grouped statement per shape, not a row scan;
 *   * scope, window and pagination values are all bound, in statement order;
 *   * no rewritten function selects `actionMetadata` or a message/tool-call row.
 *
 *   bun test apps/api/src/__tests__/analytics-rollups-postgres.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

delete process.env.SHOGO_LOCAL_MODE

interface Captured {
  sql: string
  params: unknown[]
}

const captured: Captured[] = []

const mockPrisma: any = {
  $queryRawUnsafe: mock((sql: string, ...params: unknown[]) => {
    captured.push({ sql, params })
    return Promise.resolve([] as unknown[])
  }),
  usageEvent: {
    findMany: mock(() => Promise.resolve([])),
    groupBy: mock(() => Promise.resolve([])),
  },
  toolCallLog: {
    findMany: mock(() => Promise.resolve([])),
    count: mock(() => Promise.resolve(0)),
  },
  chatMessage: { findMany: mock(() => Promise.resolve([])) },
  chatSession: { findMany: mock(() => Promise.resolve([])) },
  agentCostMetric: { findMany: mock(() => Promise.resolve([])) },
  user: { findMany: mock(() => Promise.resolve([])) },
  workspace: { findMany: mock(() => Promise.resolve([])) },
  project: { groupBy: mock(() => Promise.resolve([])), findMany: mock(() => Promise.resolve([])) },
  member: { groupBy: mock(() => Promise.resolve([])), findMany: mock(() => Promise.resolve([])) },
  subscription: { findMany: mock(() => Promise.resolve([])) },
  modelDefinition: { findMany: mock(() => Promise.resolve([])) },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma, default: mockPrisma }))
mock.module('../services/model-registry.service', () => ({
  resolveModelLabels: async (ids: Iterable<string>) =>
    new Map([...ids].map((id) => [id, id])),
}))

const analytics = await import('../services/analytics.service')
const { clearAnalyticsCache } = await import('../lib/analytics-cache')

beforeEach(() => {
  captured.length = 0
  clearAnalyticsCache()
})

/** Statements for one call, with the cache cleared so the scan runs. */
async function statements(run: () => Promise<unknown>): Promise<Captured[]> {
  captured.length = 0
  clearAnalyticsCache()
  await run()
  return [...captured]
}

describe('getToolCallAnalytics on Postgres', () => {
  test('never selects `result` and classifies failures in SQL', async () => {
    const sqls = await statements(() => analytics.getToolCallAnalytics({ workspaceId: 'ws_1' }, '30d'))

    // Three statements: totals + distinct tools, the paged per-tool rollup, the
    // daily series. Nothing else reads tool_call_logs.
    expect(sqls).toHaveLength(3)
    expect(mockPrisma.toolCallLog.findMany).not.toHaveBeenCalled()

    for (const { sql } of sqls) {
      // The 754 MB payload: `result` may be read by a predicate, never projected.
      expect(sql).not.toMatch(/SELECT[\s\S]*?tc\."result"\s+AS/i)
      expect(sql).toContain('jsonb_typeof(tc."result"')
      expect(sql).toContain('tc."status" = \'error\'')
    }
    // Totals are one aggregate over the filtered set; the paged tools and the
    // daily series are grouped.
    expect(sqls[0].sql).toContain('COUNT(DISTINCT tc."toolName")')
    expect(sqls[1].sql).toContain('GROUP BY 1')
    expect(sqls[2].sql).toContain('GROUP BY 1')

    const paged = sqls[1].sql
    expect(paged).toContain('tc."toolName" AS "toolName"')
    expect(paged).toContain('ORDER BY "total" DESC')
    // Scope: the session OR the project it belongs to.
    expect(paged).toContain('cs."workspaceId" = $')
    expect(paged).toContain('pj."workspaceId" = $')
  })

  test('binds the window, the scope and only then the page', async () => {
    const sqls = await statements(() =>
      analytics.getToolCallAnalytics({ workspaceId: 'ws_1', userId: 'u_1' }, '30d', { page: 3, limit: 5 }),
    )
    const { sql, params } = sqls[1]

    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
    expect([...new Set(placeholders)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: params.length }, (_, i) => i + 1),
    )
    // window → scope → pagination, the order the statement is assembled in.
    expect(params[0]).toBeInstanceOf(Date)
    expect(params[1]).toBeInstanceOf(Date)
    expect(params[2]).toBe('u_1')
    expect(params.slice(3)).toEqual(['ws_1', 'ws_1', 5, 10])
    expect(sql).not.toContain('ws_1')
  })
})

describe('the dashboard rollups on Postgres', () => {
  test('getSpendTimeseries aggregates day × series and its totals in SQL', async () => {
    const sqls = await statements(() => analytics.getSpendTimeseries({ workspaceId: 'ws_1' }, '30d'))

    expect(sqls).toHaveLength(2)
    expect(sqls[0].sql).toContain('GROUP BY 1, 2')
    expect(sqls[0].sql).toContain('TO_CHAR(t."createdAt", \'YYYY-MM-DD\')')
    expect(sqls[0].sql).toContain('SUM(')
    expect(sqls[1].sql).toContain('AS "onDemand"')
    expect(mockPrisma.usageEvent.findMany).not.toHaveBeenCalled()
  })

  test('getActiveUsersTimeseries returns distinct (day, member) pairs', async () => {
    const [statement] = await statements(() =>
      analytics.getActiveUsersTimeseries({ workspaceId: 'ws_1' }, '30d'),
    )

    expect(statement.sql).toContain('GROUP BY 1, 2')
    expect(statement.sql).toContain('t."memberId" <> \'system\'')
    expect(statement.sql).not.toContain('actionMetadata')
    expect(mockPrisma.usageEvent.findMany).not.toHaveBeenCalled()
  })

  test('getActivityTimeseries counts each series by day instead of loading rows', async () => {
    const sqls = await statements(() => analytics.getActivityTimeseries({ workspaceId: 'ws_1' }, '30d'))

    // members, projects, messages, sessions, tool calls (workspaces are only
    // counted on the platform scope; subscriptions stay a small typed read).
    expect(sqls.length).toBeGreaterThanOrEqual(5)
    for (const { sql } of sqls) {
      expect(sql).toContain('COUNT(*) AS "count"')
      expect(sql).toContain('GROUP BY 1')
    }
    expect(mockPrisma.chatMessage.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.toolCallLog.findMany).not.toHaveBeenCalled()
  })

  test('getQualityTimeseries sums tokens, spend and agent flags per day', async () => {
    const sqls = await statements(() => analytics.getQualityTimeseries({ workspaceId: 'ws_1' }, '30d'))

    expect(sqls).toHaveLength(3)
    expect(sqls[0].sql).toContain('COUNT(DISTINCT CASE WHEN')
    expect(sqls[0].sql).toContain('jsonb_typeof(t."actionMetadata"->\'inputTokens\')')
    expect(sqls[2].sql).toContain('FROM "agent_cost_metrics"')
    expect(mockPrisma.usageEvent.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.agentCostMetric.findMany).not.toHaveBeenCalled()
  })

  test('getChatAnalytics counts sessions, messages and tool calls', async () => {
    const sqls = await statements(() => analytics.getChatAnalytics({ projectId: 'p_1' }, '30d'))

    expect(sqls).toHaveLength(3)
    for (const { sql } of sqls) expect(sql).toContain('COUNT(*)')
    expect(mockPrisma.chatSession.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.chatMessage.findMany).not.toHaveBeenCalled()
  })

  test('getUsageSummary reads the cached group scan, not the raw events', async () => {
    const sqls = await statements(() => analytics.getUsageSummary({ workspaceId: 'ws_1' }, '30d'))

    expect(sqls).toHaveLength(1)
    expect(sqls[0].sql).toContain('GROUP BY 1, 2, 3, 4, 5, 6')
    // acceptance 2: the JSON is opened in the database and never selected.
    expect(sqls[0].sql).not.toMatch(/SELECT[\s\S]*?"actionMetadata"\s+AS/i)
    expect(mockPrisma.usageEvent.findMany).not.toHaveBeenCalled()
  })

  test('getWorkspaceActivityTable asks the database which workspaces are real', async () => {
    const sqls = await statements(() =>
      analytics.getWorkspaceActivityTable('30d', { excludeInternal: true }),
    )

    const distinct = sqls.find(({ sql }) => sql.includes('SELECT DISTINCT'))
    expect(distinct).toBeDefined()
    expect(distinct!.sql).toContain('FROM "members"')
    expect(mockPrisma.member.findMany).not.toHaveBeenCalled()
  })

  /**
   * QA round 1 (SHO-311) shipped two expressions that SQLite accepts and
   * Postgres rejects or mis-reads, and a text assertion could not see either.
   * These two invariants are the cheap half of the fix: they need no Postgres,
   * so the `test` job catches a regression before the `rbac-postgres` job does.
   */
  test('the emitted Postgres SQL never negates an integer CASE', async () => {
    const sqls = [
      ...(await statements(() => analytics.getQualityTimeseries({ workspaceId: 'ws_1' }, '30d'))),
      ...(await statements(() => analytics.getToolCallAnalytics({ workspaceId: 'ws_1' }, '30d'))),
      ...(await statements(() => analytics.getActivityTimeseries({ workspaceId: 'ws_1' }, '30d'))),
    ]

    expect(sqls.length).toBeGreaterThan(0)
    for (const { sql } of sqls) {
      // `jsonTrue`/`jsonFalse` build `CASE … THEN 1 ELSE 0 END`; `NOT` on that
      // is PG 42804 ("argument of NOT must be type boolean, not type integer").
      expect(sql).not.toMatch(/NOT\s*\(?\s*CASE/i)
    }
  })

  test('the error-word regex is spelled for Postgres ARE', async () => {
    const sqls = await statements(() => analytics.getToolCallAnalytics({ workspaceId: 'ws_1' }, '30d'))
    const withRegex = sqls.filter(({ sql }) => sql.includes('~*'))

    expect(withRegex.length).toBeGreaterThan(0)
    for (const { sql } of withRegex) {
      // `\b` is a backspace in Postgres ARE (the word boundary is `\y`), and a
      // double-escaped literal reaches the server as a literal backslash.
      expect(sql).toContain("~* '^\\s*error\\y'")
      expect(sql).not.toContain('\\\\s')
      expect(sql).not.toContain('\\\\y')
    }
  })
})
