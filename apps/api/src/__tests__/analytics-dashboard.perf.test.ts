// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-140 acceptance 1–3, 7 — the Usage tab's cost on a workspace with real
 * usage.
 *
 * Seeds 100k metered events for one workspace and asserts, against a real
 * database (SQLite here; set CHANNELS_TEST_PG_URL to run the same file against
 * Postgres — no cloud-only or desktop-only branch):
 *
 *   a) one `usage_events` scan per dashboard request — before, a single open
 *      scanned the table three times;
 *   b) on Postgres that one scan is an aggregate that never selects
 *      `actionMetadata` (~42 MB of JSONB per scan before; acceptance 2's
 *      < 1 MB). SQLite reads the JSON in Node instead — measured cheaper than
 *      `json_extract` per key over every row, which is the local fix the plan
 *      asked for — so there the assertion is that no SQL touches the JSON;
 *   c) the response body stays small and the request finishes well inside the
 *      time a person would notice (a regression bound, not a benchmark);
 *   d) `EXPLAIN QUERY PLAN` uses the new composite index for the window scan.
 *
 *   bun test apps/api/src/__tests__/analytics-dashboard.perf.test.ts
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from './helpers/channels-test-db'
import { pinClockIntoCacheBucket, restoreClock } from './helpers/analytics-bucket'

const SEEDED_EVENTS = 100_000
const WINDOW_DAYS = 30

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const analytics = await import('../services/analytics.service')
const { clearAnalyticsCache } = await import('../lib/analytics-cache')
const db = prisma as any

/** A pinned clock never outlives the test that pinned it. */
afterEach(() => restoreClock())

/** `setupChannelsTestDb` points the client at SQLite unless CHANNELS_TEST_PG_URL is set. */
const isSqlite = process.env.SHOGO_LOCAL_MODE === 'true'

interface QueryLog {
  sql: string
  rows: number
  /** Bytes of `actionMetadata` in the returned rows — the number acceptance 2 caps. */
  actionMetadataBytes: number
}

const queries: QueryLog[] = []
let usageEventSelects = 0

function bytesOf(value: unknown): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'string' ? Buffer.byteLength(value) : Buffer.byteLength(JSON.stringify(value))
}

let workspaceId = ''

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const workspace = await db.workspace.create({
    data: { name: 'Heavy Usage', slug: `heavy-usage-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  const project = await db.project.create({ data: { name: 'Heavy', workspaceId } })
  const members = await Promise.all(
    ['ann', 'ben', 'cat', 'dan', 'eve'].map((name) =>
      db.user.create({ data: { name, email: `${name}-${suffix}@example.com` } })),
  )

  const models = ['claude-sonnet-4-5', 'gpt-5', 'hoshi-2-0', 'claude-haiku-4-5', 'mimo-v2.5']
  const now = Date.now()
  const chunk: any[] = []

  for (let i = 0; i < SEEDED_EVENTS; i += 1) {
    const model = models[i % models.length]
    chunk.push({
      workspaceId,
      projectId: i % 10 === 0 ? null : project.id,
      memberId: members[i % members.length].id,
      actionType: i % 7 === 0 ? 'voice_minutes_inbound' : 'ai_proxy_completion',
      source: i % 11 === 0 ? 'overage' : 'daily',
      billedUsd: (i % 5) / 1_000_000,
      rawUsd: (i % 4) / 1_000_000,
      balanceBefore: 0,
      balanceAfter: 0,
      createdAt: new Date(now - ((i * 7919) % (WINDOW_DAYS * 24 * 60 * 60 * 1000))),
      actionMetadata: {
        model,
        provider: model.startsWith('gpt') ? 'openai' : 'anthropic',
        inputTokens: 1_000 + (i % 500),
        outputTokens: 200 + (i % 300),
        cachedInputTokens: i % 3 === 0 ? 400 : 0,
        cacheWriteTokens: 0,
        durationMs: 900,
        // Enough text that "the JSON never leaves the database" is measurable:
        // ~300 bytes per event, i.e. ~30 MB for the window.
        note: 'x'.repeat(220),
      },
    })
    if (chunk.length === 1_000) {
      await db.usageEvent.createMany({ data: chunk.splice(0, chunk.length) })
    }
  }
  if (chunk.length > 0) await db.usageEvent.createMany({ data: chunk })

  // Instrument after seeding so only the request under test is measured.
  const originalQueryRawUnsafe = db.$queryRawUnsafe.bind(db)
  db.$queryRawUnsafe = (async (sql: string, ...rest: any[]) => {
    const result = await originalQueryRawUnsafe(sql, ...rest)
    if (Array.isArray(result) && /usage_events/i.test(String(sql))) {
      queries.push({
        sql: String(sql),
        rows: result.length,
        actionMetadataBytes: result.reduce((sum, row) => sum + bytesOf(row?.actionMetadata), 0),
      })
    }
    return result
  }) as any

  for (const model of ['usageEvent']) {
    const original = db[model].findMany.bind(db[model])
    db[model].findMany = (async (...args: any[]) => {
      usageEventSelects += 1
      return original(...args)
    }) as any
  }
  // Seeding 100k rows takes 4-7 s on a cold runner, past bun's 5 s default hook
  // budget: state it instead of hoping the machine is fast (SHO-186).
}, 120_000)

function resetCounters() {
  queries.length = 0
  usageEventSelects = 0
  clearAnalyticsCache()
}

describe('the dashboard reads usage_events once, without the JSON', () => {
  test('one scan, no JSON in SQL, small body, bounded time', async () => {
    resetCounters()

    const started = performance.now()
    const data = await analytics.getUsageDashboard({ workspaceId }, { period: '30d', limit: 50 })
    const elapsedMs = performance.now() - started

    // (a) exactly one pass over usage_events, whichever engine this runs on.
    expect(queries.length + usageEventSelects).toBe(1)

    if (isSqlite) {
      // The desktop path parses the JSON in Node from that single row scan
      // instead of asking SQLite to `json_extract` every key of every row
      // (measured slower — see the plan's 93 ms vs 33 ms).
      expect(usageEventSelects).toBe(1)
      expect(queries.length).toBe(0)
    } else {
      // (b) acceptance 2: nothing JSON-shaped crosses the wire.
      expect(queries.length).toBe(1)
      expect(queries[0].sql).toContain('GROUP BY')
      expect(usageEventSelects).toBe(0)
      // The roll-up is tiny next to the 100k rows it summarises.
      expect(queries[0].rows).toBeLessThan(1_000)
      expect(queries[0].actionMetadataBytes).toBe(0)
      expect(queries.reduce((s, q) => s + q.actionMetadataBytes, 0)).toBeLessThan(1_000_000)
    }

    // No statement anywhere reads the JSON column inside the database.
    expect(queries.every((q) => !/actionMetadata/i.test(q.sql))).toBe(true)

    // A 100k-event workspace still returns a normal-sized payload.
    const body = JSON.stringify(data)
    expect(Buffer.byteLength(body)).toBeLessThan(200_000)

    // (c) regression bound only — measured ~x00 ms locally.
    expect(elapsedMs).toBeLessThan(2_000)

    expect(data.summary.totals.totalRequests).toBeGreaterThan(80_000)
    expect(data.summary.total).toBeGreaterThan(0)
  })

  test('a second open inside the TTL does not scan again', async () => {
    // The cache key buckets the rolling window, so both opens have to share a
    // bucket — that is the invariant, not something to wait for. Pin the clock
    // inside one: the old sleep up to the next boundary reached 10 050 ms,
    // longer than this test's timeout, so a run starting within ~5 s of a
    // boundary failed before it asserted and the immediate retry failed with it
    // (SHO-186).
    pinClockIntoCacheBucket()

    resetCounters()
    await analytics.getUsageDashboard({ workspaceId }, { period: '30d' })
    const afterFirst = queries.length + usageEventSelects
    await analytics.getUsageDashboard({ workspaceId }, { period: '30d' })
    expect(afterFirst).toBe(1)
    expect(queries.length + usageEventSelects).toBe(1)
  })

  test('the window scan is served by the composite index', async () => {
    const from = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const plan = await db.$queryRawUnsafe(
      'EXPLAIN QUERY PLAN SELECT COUNT(*) FROM "usage_events" WHERE "workspaceId" = ? AND "createdAt" >= ? AND "createdAt" < ?',
      workspaceId,
      from,
      new Date(),
    )
    const detail = (plan as any[]).map((row) => String(row.detail ?? '')).join('\n')
    expect(detail).toContain('usage_events_workspaceId_createdAt_idx')
    // The old single-column index made SQLite re-check every row of the
    // workspace; the composite one narrows it to the window.
    expect(detail.toLowerCase()).not.toContain('scan usage_events')
  })
})
