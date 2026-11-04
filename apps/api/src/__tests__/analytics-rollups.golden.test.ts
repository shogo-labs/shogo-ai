// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-311 acceptance 3 — the rewritten rollups return the numbers the old
 * row-by-row code returned.
 *
 * The analytics reads used to `findMany` a window and count in Node; they now
 * aggregate in SQL (one dialect, both engines). This file seeds a real database
 * with a fixture whose answers are written down by hand, so a drift in any of
 * the SQL rollups — a lost day bucket, a session scope that drops
 * workspace-only chats, an error-classification branch — fails here rather than
 * in production.
 *
 * It runs on whatever engine `setupChannelsTestDb` selects: SQLite by default,
 * Postgres when `CHANNELS_TEST_PG_URL` is set. The same assertions must pass on
 * both — that is the desktop/cloud-parity half of the card.
 *
 *   bun test apps/api/src/__tests__/analytics-rollups.golden.test.ts
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from './helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const analytics = await import('../services/analytics.service')
const { clearAnalyticsCache } = await import('../lib/analytics-cache')
const db = prisma as any

const suffix = crypto.randomUUID().slice(0, 8)
const DAY = 24 * 60 * 60 * 1000

/**
 * `ToolCallLog.result` is `Json?` in the cloud schema and `String?` on the
 * desktop one, so the same fixture writes an object on Postgres and its JSON
 * text on SQLite — which is exactly what each app's writer does.
 */
const jsonColumn = (value: unknown) =>
  process.env.SHOGO_LOCAL_MODE === 'true' ? JSON.stringify(value) : value

let workspaceId = ''
let projectId = ''
let aliceId = ''
let bobId = ''
let dayA = 0
let dayB = 0

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { name: 'Rollups', slug: `rollups-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  const project = await db.project.create({ data: { name: 'Rollups', workspaceId } })
  projectId = project.id

  const [alice, bob] = await Promise.all([
    db.user.create({ data: { name: 'Alice', email: `roll-alice-${suffix}@example.com` } }),
    db.user.create({ data: { name: 'Bob', email: `roll-bob-${suffix}@example.com` } }),
  ])
  aliceId = alice.id
  bobId = bob.id

  await db.member.createMany({
    data: [
      { userId: alice.id, workspaceId, role: 'admin' },
      { userId: bob.id, workspaceId, role: 'member' },
    ],
  })

  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY)
  dayA = 3
  dayB = 2

  const projectSession = await db.chatSession.create({
    data: { inferredName: 'project chat', contextType: 'project', contextId: project.id, createdAt: at(dayB) },
  })
  // A workspace-scoped session (no project): the row the old project-only join
  // dropped from every tool-call total (SHO-140's bug, still here in
  // getToolCallAnalytics before this card).
  const workspaceSession = await db.chatSession.create({
    data: {
      inferredName: 'workspace chat',
      contextType: 'workspace',
      workspaceId,
      createdByUserId: alice.id,
      createdAt: at(dayA),
    },
  })

  await db.toolCallLog.createMany({
    data: [
      // dayA — 3 calls, 2 failures
      { chatSessionId: projectSession.id, messageId: `a1-${suffix}`, toolName: 'read_file', status: 'complete', result: jsonColumn({ ok: true }), duration: 100, userId: aliceId, createdAt: at(dayA) },
      { chatSessionId: projectSession.id, messageId: `a2-${suffix}`, toolName: 'grep', status: 'error', result: null, duration: 50, userId: bobId, createdAt: at(dayA) },
      { chatSessionId: workspaceSession.id, messageId: `a3-${suffix}`, toolName: 'write_file', status: 'complete', result: jsonColumn({ isError: true }), duration: 400, userId: bobId, createdAt: at(dayA) },
      // dayB — 7 calls, 5 failures
      { chatSessionId: projectSession.id, messageId: `b1-${suffix}`, toolName: 'read_file', status: 'complete', result: jsonColumn({ success: false }), duration: 300, userId: aliceId, createdAt: at(dayB) },
      { chatSessionId: workspaceSession.id, messageId: `b2-${suffix}`, toolName: 'grep', status: 'complete', result: jsonColumn('error: boom'), duration: 200, userId: aliceId, createdAt: at(dayB) },
      { chatSessionId: projectSession.id, messageId: `b3-${suffix}`, toolName: 'write_file', status: 'complete', result: jsonColumn({ state: 'Error' }), duration: 250, userId: bobId, createdAt: at(dayB) },
      { chatSessionId: projectSession.id, messageId: `b4-${suffix}`, toolName: 'edit', status: 'complete', result: jsonColumn({ text: '  ERROR: nope' }), userId: bobId, createdAt: at(dayB) },
      // `error` present and not false
      { chatSessionId: projectSession.id, messageId: `b5-${suffix}`, toolName: 'edit', status: 'complete', result: jsonColumn({ error: 'kaboom' }), userId: bobId, createdAt: at(dayB) },
      // `error: false` is not a failure
      { chatSessionId: projectSession.id, messageId: `b6-${suffix}`, toolName: 'edit', status: 'complete', result: jsonColumn({ error: false }), userId: bobId, createdAt: at(dayB) },
      // "errors are fine" — a word boundary, so not a failure
      { chatSessionId: projectSession.id, messageId: `b7-${suffix}`, toolName: 'edit', status: 'complete', result: jsonColumn({ text: 'errors are fine' }), userId: bobId, createdAt: at(dayB) },
    ],
  })

  await db.chatMessage.createMany({
    data: [
      { sessionId: projectSession.id, role: 'user', content: 'hi', createdAt: at(dayB) },
      { sessionId: projectSession.id, role: 'user', content: 'again', createdAt: at(dayB) },
      { sessionId: projectSession.id, role: 'assistant', content: 'hello', createdAt: at(dayB) },
    ],
  })

  await db.usageEvent.createMany({
    data: [
      { workspaceId, memberId: aliceId, actionType: 'ai_proxy_completion', source: 'daily', billedUsd: 0.5, rawUsd: 0.4, balanceBefore: 0, balanceAfter: 0, createdAt: at(dayA), actionMetadata: { model: 'm1', inputTokens: 100, cachedInputTokens: 50 } },
      { workspaceId, memberId: aliceId, actionType: 'ai_proxy_completion', source: 'daily', billedUsd: 0.5, rawUsd: 0.4, balanceBefore: 0, balanceAfter: 0, createdAt: at(dayB), actionMetadata: { model: 'm1', inputTokens: 100, cachedInputTokens: 50 } },
      { workspaceId, memberId: bobId, actionType: 'ai_proxy_completion', source: 'daily', billedUsd: 0.5, rawUsd: 0.4, balanceBefore: 0, balanceAfter: 0, createdAt: at(dayB), actionMetadata: { model: 'm1', inputTokens: 100, cachedInputTokens: 50 } },
    ],
  })
})

// The usage-group scan behind `getUsageSummary` is cached per window.
beforeEach(() => clearAnalyticsCache())

const points = (days: { date: string }[]) => days.map((d) => d.date)

function dayKey(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10)
}

describe('getToolCallAnalytics', () => {
  test('classifies every toolCallFailed branch and averages non-null durations', async () => {
    const out = await analytics.getToolCallAnalytics({ workspaceId }, '30d', { limit: 10 })

    const byTool = new Map(out.tools.map((tool) => [tool.toolName, tool]))
    // Ranked by call count, ties broken by name.
    expect(out.tools.map((tool) => tool.toolName)).toEqual(['edit', 'grep', 'read_file', 'write_file'])

    expect(byTool.get('read_file')).toMatchObject({ total: 2, errors: 1, avgDurationMs: 200 })
    expect(byTool.get('grep')).toMatchObject({ total: 2, errors: 2, avgDurationMs: 125 })
    expect(byTool.get('write_file')).toMatchObject({ total: 2, errors: 2, avgDurationMs: 325 })
    // `error: false` and "errors are fine" are not failures.
    expect(byTool.get('edit')).toMatchObject({ total: 4, errors: 2, avgDurationMs: 0 })

    expect(out.totals.totalCalls).toBe(10)
    expect(out.totals.totalErrors).toBe(7)
    expect(out.totals.successRate).toBeCloseTo(30, 6)
    expect(out.total).toBe(4)
  })

  test('counts workspace-only sessions, and filters them by member', async () => {
    // grep/write_file rows on the workspace-scoped session are in the workspace
    // total; scoping to Alice drops Bob's rows but keeps hers.
    const mine = await analytics.getToolCallAnalytics({ workspaceId, userId: aliceId }, '30d', { limit: 10 })

    expect(mine.totals.totalCalls).toBe(3)
    expect(mine.totals.totalErrors).toBe(2)
    expect(mine.tools.map((tool) => tool.toolName)).toEqual(['read_file', 'grep'])
  })

  test('pages the tool table and still reports the full total', async () => {
    const first = await analytics.getToolCallAnalytics({ workspaceId }, '30d', { page: 1, limit: 2 })
    const second = await analytics.getToolCallAnalytics({ workspaceId }, '30d', { page: 2, limit: 2 })

    expect(first.tools.map((tool) => tool.toolName)).toEqual(['edit', 'grep'])
    expect(second.tools.map((tool) => tool.toolName)).toEqual(['read_file', 'write_file'])
    expect(first.total).toBe(4)
    // Totals cover every tool, not just the page.
    expect(second.totals.totalCalls).toBe(10)
  })

  test('the daily series counts calls and errors per day', async () => {
    const out = await analytics.getToolCallAnalytics({ workspaceId }, '30d', { limit: 10 })
    const byDate = new Map(out.daily.map((point) => [point.date, point]))

    expect(byDate.get(dayKey(dayA))).toMatchObject({ calls: 3, errors: 2 })
    expect(byDate.get(dayKey(dayB))).toMatchObject({ calls: 7, errors: 5 })
    // Zero-filled days inside the window stay zero.
    expect(byDate.get(dayKey(10))).toMatchObject({ calls: 0, errors: 0, successRate: 100 })
  })
})

describe('getActiveUsersTimeseries', () => {
  test('DISTINCT day/member pairs give the same DAU/WAU/MAU', async () => {
    const series = await analytics.getActiveUsersTimeseries({ workspaceId }, '30d')
    const byDate = new Map(series.map((point) => [point.date, point]))

    expect(byDate.get(dayKey(dayA))).toMatchObject({ dau: 1, wau: 1, mau: 1 })
    expect(byDate.get(dayKey(dayB))).toMatchObject({ dau: 2, wau: 2, mau: 2 })
    // Outside the active days the windows still see the earlier ones.
    expect(byDate.get(dayKey(0))).toMatchObject({ dau: 0, wau: 2, mau: 2 })
  })
})

describe('getActivityTimeseries', () => {
  test('counts each series per day in the database', async () => {
    const series = await analytics.getActivityTimeseries({ workspaceId }, '30d')
    const byDate = new Map(series.map((point) => [point.date, point]))

    // Members are stamped now, projects/messages/sessions/tool calls at the
    // seeded days. A workspace-scoped session has no project, so it is not part
    // of the workspace's session/tool-call activity (the old relation's rule).
    expect(byDate.get(dayKey(dayA))).toMatchObject({ messages: 0, sessions: 0, toolCalls: 2 })
    expect(byDate.get(dayKey(dayB))).toMatchObject({ messages: 2, sessions: 1, toolCalls: 6 })
    expect(series.map((point) => point.date)).toContain(dayKey(0))
  })
})

describe('getChatAnalytics', () => {
  test('counts sessions, messages and tool calls per workspace', async () => {
    const out = await analytics.getChatAnalytics({ workspaceId }, '30d')

    expect(out.totalSessions).toBe(1)
    expect(out.totalMessages).toBe(2)
    expect(out.totalToolCalls).toBe(8)
    expect(out.avgMessagesPerSession).toBe(2)
    expect(out.dailySessions).toEqual([{ date: dayKey(dayB), count: 1 }])
  })
})

describe('getQualityTimeseries', () => {
  test('per-day cache ratio, unit cost and agent rates', async () => {
    const series = await analytics.getQualityTimeseries({ workspaceId }, '30d')
    const byDate = new Map(series.map((point) => [point.date, point]))

    // 50 of 100 input tokens were cached on each active day.
    expect(byDate.get(dayKey(dayB))!.cacheHitRatio).toBeCloseTo(50 / 150, 6)
    // Three events on dayB (two of them), spend 1.0 over 2 messages.
    expect(byDate.get(dayKey(dayB))!.costPerMessage).toBeCloseTo(1 / 2, 6)
    // Two distinct active members on dayB.
    expect(byDate.get(dayKey(dayB))!.costPerActiveUser).toBeCloseTo(1 / 2, 6)
    // No agent runs seeded, so every rate is 0 rather than NaN.
    expect(byDate.get(dayKey(dayB))!.agentEscalatedRate).toBe(0)
    expect(points(series)).toContain(dayKey(0))
  })
})

describe('getUsageSummary', () => {
  test('still aggregates the metered window per member and model', async () => {
    const out = await analytics.getUsageSummary({ workspaceId }, '30d', { limit: 50 })

    expect(out.totals.totalRequests).toBe(3)
    expect(out.totals.totalBilledUsd).toBeCloseTo(1.5, 6)
    expect(out.summaries.length).toBe(2)
    // `toolCallWhereFor` counts completed calls, so the `status: 'error'` row is
    // not in this total (the tool-call page, which classifies failures, sees 10).
    expect(out.totals.totalToolCalls).toBe(9)
  })
})
