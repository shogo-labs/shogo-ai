// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Postgres-branch coverage for src/services/analytics.service.ts.
//
// The service captures its dialect ONCE at module load via:
//   const isSqlite = process.env.SHOGO_LOCAL_MODE === 'true'
// Every other test file in this package imports it under
// SHOGO_LOCAL_MODE=true (Bun's default for dev.db), so the
// Postgres branches inside getUserFunnel / getUserActivityTable
// / getTemplateEngagement / getChatConversations are uncovered.
// This file deletes SHOGO_LOCAL_MODE BEFORE the dynamic import
// so the module loads with isSqlite=false. Per-file isolation
// (run-tests-isolated.ts) keeps the env mutation scoped.

import { describe, test, expect, mock, beforeEach } from 'bun:test'

delete process.env.SHOGO_LOCAL_MODE

const captured: string[] = []

const mockPrisma = {
  $queryRawUnsafe: mock((sql: string) => {
    captured.push(sql)
    return Promise.resolve([] as unknown[])
  }),
  user: { findMany: mock(() => Promise.resolve([])), count: mock(() => Promise.resolve(0)) },
  project: { groupBy: mock(() => Promise.resolve([])) },
  chatMessage: { groupBy: mock(() => Promise.resolve([])) },
  usageEvent: { groupBy: mock(() => Promise.resolve([])) },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma, default: mockPrisma }))

const {
  getUserFunnel,
  getUserActivityTable,
  getTemplateEngagement,
  getChatConversations,
  getGrowthTimeSeries,
} = await import('../services/analytics.service')

beforeEach(() => {
  captured.length = 0
  mockPrisma.$queryRawUnsafe.mockClear()
})

const since = new Date('2026-01-01T00:00:00Z')

describe('analytics.service.ts — Postgres dialect branches (SHOGO_LOCAL_MODE unset)', () => {
  test('getUserFunnel emits Postgres-style query with WITH real_users CTE', async () => {
    await getUserFunnel(since)
    const q = captured[0] ?? ''
    expect(q).toContain('WITH real_users')
    // pg-only token — sqlite branch uses `::int` cast differently; this CTE
    // exists ONLY in the pg arm. Asserting any pg-distinctive token suffices.
    expect(q).toContain('COUNT')
  })

  test('getUserActivityTable emits Postgres dialect for all 3 sub-queries (count::int casts)', async () => {
    await getUserActivityTable(since, ['u-1', 'u-2'])
    expect(captured.length).toBeGreaterThanOrEqual(3)
    // pg arms use the `::int` cast; sqlite arms don't.
    const allHavePgCast = captured.every((sql) => sql.includes('::int'))
    expect(allHavePgCast).toBe(true)
  })

  test('getTemplateEngagement emits Postgres-style WITH template_projects CTE', async () => {
    await getTemplateEngagement(since)
    const q = captured[0] ?? ''
    expect(q).toContain('WITH template_projects')
    expect(q).toContain('marketplace_listings')
  })

  test('getChatConversations emits RIGHT() — Postgres truncation operator', async () => {
    await getChatConversations(since, true)
    const q = captured[0] ?? ''
    expect(q).toContain('RIGHT(cm."content"')
    expect(q).toContain('1000')
    // Postgres uses positional parameters $1 instead of sqlite's ?
    expect(q).toContain('$1')
  })

  test('getGrowthTimeSeries (platform) buckets by day in SQL for the four core tables', async () => {
    await getGrowthTimeSeries()
    // One grouped COUNT per table: users, workspaces, projects, chat_sessions.
    expect(captured.length).toBe(4)
    expect(captured.every((sql) => sql.includes(`date_trunc('day', "createdAt")`))).toBe(true)
    expect(captured.every((sql) => sql.includes('$1'))).toBe(true)
    const tables = captured.map((sql) => sql.match(/FROM "(\w+)"/)?.[1])
    expect(tables).toEqual(['users', 'workspaces', 'projects', 'chat_sessions'])
  })

})
