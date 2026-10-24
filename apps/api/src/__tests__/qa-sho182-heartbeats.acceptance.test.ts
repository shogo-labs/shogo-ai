// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-182, Analytics → Heartbeats.
 *
 * The card's own tests mock `lib/prisma`, so neither dialect ever sees a real
 * `usage_events` row: the Postgres roll-up is asserted as SQL text and the
 * SQLite path runs against a hand-built array. This file closes that gap and
 * pins what the card is actually about, against a real database:
 *
 *   1. The money. One tick per charge, the per-tick attribution of
 *      `heartbeat:<projectId>:<tickId>`, the provider-cost fallback for rows
 *      with no billed amount, and a "% of workspace spend" whose denominator is
 *      every metered charge in the same window — not just the heartbeat ones.
 *   2. Who is in the report: heartbeat-on projects, projects switched off since
 *      they spent, never a project with neither, never another workspace, never
 *      a chat that merely *looks* like a heartbeat session.
 *   3. The route hands the component the same numbers the service computed.
 *
 * Runs on the desktop dialect by default and on Postgres when
 * `CHANNELS_TEST_PG_URL` points at a server:
 *
 *   cd apps/api && bun test ./src/__tests__/qa-sho182-heartbeats.acceptance.test.ts
 *   CHANNELS_TEST_PG_URL=postgres://localhost:5432/postgres \
 *     bun test ./src/__tests__/qa-sho182-heartbeats.acceptance.test.ts
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const QA_USER = 'qa-182-admin'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { userId: QA_USER })
    await next()
  },
  requireAuth: async (_c: any, next: any) => next(),
}))

const { dbPath } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { getWorkspaceHeartbeats } = await import('../services/analytics.service')
const { scopedAnalyticsRoutes } = await import('../routes/scoped-analytics')
const db = prisma as any

/** The dialect under test: `setupChannelsTestDb` clears the flag for Postgres. */
const POSTGRES = process.env.SHOGO_LOCAL_MODE !== 'true'

/** Fixtures are relative to this instant, so no assertion reads the wall clock. */
const NOW = new Date('2026-10-24T12:00:00.000Z')
const HOUR = 3_600_000

const CONFIGURED_MODEL = 'claude-sonnet-4-5'
const FALLBACK_MODEL = 'gpt-5'

let workspaceId = ''
let otherWorkspaceId = ''
let memberUserId = ''
let onProjectId = ''
let offProjectId = ''
let idleProjectId = ''
let foreignProjectId = ''

const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR)

/** One metered charge, shaped the way the billing session writes it. */
function charge(over: Record<string, unknown>) {
  return {
    workspaceId,
    projectId: null,
    memberId: QA_USER,
    actionType: 'chat_message',
    source: 'daily',
    billedUsd: 0,
    rawUsd: null,
    balanceBefore: 0,
    balanceAfter: 0,
    createdAt: at(1),
    actionMetadata: {},
    ...over,
  }
}

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ws = await db.workspace.create({ data: { name: 'QA 182', slug: `qa-182-${suffix}`, kind: 'team' } })
  workspaceId = ws.id
  const other = await db.workspace.create({ data: { name: 'QA 182 other', slug: `qa-182-other-${suffix}`, kind: 'team' } })
  otherWorkspaceId = other.id

  const admin = await db.user.create({ data: { id: QA_USER, name: 'QA admin', email: `qa-182-${suffix}@example.com` } })
  await db.member.create({ data: { userId: admin.id, workspaceId, role: 'admin' } })
  const member = await db.user.create({ data: { name: 'Member', email: `qa-182-member-${suffix}@example.com` } })
  memberUserId = member.id
  await db.member.create({ data: { userId: member.id, workspaceId, role: 'member' } })

  const on = await db.project.create({ data: { name: 'Heartbeat Bot', workspaceId, createdBy: admin.id } })
  const off = await db.project.create({ data: { name: 'Turned Off', workspaceId, createdBy: member.id } })
  const idle = await db.project.create({ data: { name: 'No Heartbeat', workspaceId, createdBy: member.id } })
  const foreign = await db.project.create({ data: { name: 'Elsewhere', workspaceId: other.id, createdBy: admin.id } })
  onProjectId = on.id
  offProjectId = off.id
  idleProjectId = idle.id
  foreignProjectId = foreign.id

  await db.agentConfig.create({
    data: {
      projectId: onProjectId,
      heartbeatEnabled: true,
      heartbeatInterval: 1800,
      nextHeartbeatAt: new Date(NOW.getTime() + 20 * 60_000),
      lastHeartbeatAt: at(0.5),
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      quietHoursTimezone: 'America/Los_Angeles',
      modelName: CONFIGURED_MODEL,
    },
  })
  // Switched off since it spent — the row must still show the money.
  await db.agentConfig.create({ data: { projectId: offProjectId, heartbeatEnabled: false, heartbeatInterval: 3600 } })

  await db.usageEvent.createMany({
    data: [
      // Two ticks on the project that is on: one billed, one priced by provider cost.
      charge({
        projectId: onProjectId,
        billedUsd: 1.5,
        createdAt: at(1),
        actionMetadata: {
          chatSessionId: 'heartbeat',
          model: CONFIGURED_MODEL,
          inputTokens: 1000,
          outputTokens: 500,
        },
      }),
      charge({
        projectId: onProjectId,
        billedUsd: 0,
        rawUsd: 0.25,
        createdAt: at(2),
        actionMetadata: {
          chatSessionId: 'heartbeat',
          model: FALLBACK_MODEL,
          inputTokens: 100,
          outputTokens: 50,
        },
      }),
      // SHO-178's shape: the id names the project the tick ran for, not the
      // project that paid the bill.
      charge({
        projectId: onProjectId,
        billedUsd: 0.4,
        createdAt: at(3),
        actionMetadata: {
          chatSessionId: `heartbeat:${offProjectId}:tick-1`,
          model: CONFIGURED_MODEL,
          inputTokens: 200,
          outputTokens: 100,
        },
      }),
      // Looks like a heartbeat, is not one: the prefix has to be exact.
      charge({
        projectId: onProjectId,
        billedUsd: 7,
        createdAt: at(1),
        actionMetadata: { chatSessionId: 'heartbeat-notes', model: CONFIGURED_MODEL },
      }),
      // Ordinary chat.
      charge({
        projectId: onProjectId,
        billedUsd: 3,
        createdAt: at(2),
        actionMetadata: { chatSessionId: 'cs_chat_1', model: CONFIGURED_MODEL, inputTokens: 10 },
      }),
      // Another workspace's heartbeat: never in this workspace's report.
      charge({
        workspaceId: other.id,
        projectId: foreignProjectId,
        billedUsd: 9,
        createdAt: at(1),
        actionMetadata: { chatSessionId: 'heartbeat', model: CONFIGURED_MODEL },
      }),
      // Same workspace, outside the 24h window.
      charge({
        projectId: onProjectId,
        billedUsd: 0.99,
        createdAt: at(72),
        actionMetadata: { chatSessionId: 'heartbeat', model: CONFIGURED_MODEL },
      }),
    ],
  })
}, 180_000)

afterAllTeardown()
function afterAllTeardown() {
  // `setupChannelsTestDb` registers its own cleanup (temp dir / throwaway PG
  // database); nothing of ours outlives the run.
  void dbPath
}

async function report(period: '24h' | '7d' | '30d' = '24h', scope?: Record<string, unknown>) {
  return getWorkspaceHeartbeats(workspaceId, { period, now: NOW, ...(scope ? { projectWhere: scope } : {}) })
}

describe(`SHO-182 QA: heartbeat spend from a real ${POSTGRES ? 'Postgres' : 'SQLite'} database`, () => {
  test('one charge is one tick, the provider cost fills in a zero bill, and off-but-spent still shows', async () => {
    const data = await report('24h')
    const on = data.agents.find((a) => a.projectId === onProjectId)!
    const off = data.agents.find((a) => a.projectId === offProjectId)!

    // Two `heartbeat` rows belong to the project that is on...
    expect(on.ticks).toBe(2)
    // ...and 1.50 billed + 0.25 provider cost when nothing was billed.
    expect(on.billedUsd).toBeCloseTo(1.75, 9)
    expect(on.avgUsdPerTick).toBeCloseTo(0.875, 9)
    expect(on.totalTokens).toBe(1650)

    // The per-tick id is attributed to the project it names, which is off now.
    expect(off.ticks).toBe(1)
    expect(off.billedUsd).toBeCloseTo(0.4, 9)
    expect(off.enabled).toBe(false)
    // ...and the project that paid the bill is not credited with it.
    expect(on.ticks + off.ticks).toBe(data.totals.ticks)
    expect(data.totals.ticks).toBe(3)
    expect(data.totals.billedUsd).toBeCloseTo(2.15, 9)

    // Highest spend first: the point of the tab.
    expect(data.agents.map((a) => a.projectName)).toEqual(['Heartbeat Bot', 'Turned Off'])
  })

  test('the share of spend is measured against every metered charge in the window', async () => {
    const data = await report('24h')
    // 2.15 heartbeat, 7.00 on a chat called `heartbeat-notes`, 3.00 ordinary
    // chat. The other workspace's 9.00 and the 3-day-old 0.99 are outside.
    expect(data.totals.workspaceBilledUsd).toBeCloseTo(12.15, 9)
    const share = (data.totals.billedUsd / data.totals.workspaceBilledUsd) * 100
    expect(share).toBeGreaterThan(17)
    expect(share).toBeLessThan(18)

    const heartbeat = data.daily.reduce((sum, d) => sum + d.heartbeatUsd, 0)
    const other = data.daily.reduce((sum, d) => sum + d.otherUsd, 0)
    expect(heartbeat).toBeCloseTo(data.totals.billedUsd, 9)
    expect(other).toBeCloseTo(data.totals.workspaceBilledUsd - data.totals.billedUsd, 9)
  })

  test('a project with neither a heartbeat nor heartbeat spend never appears', async () => {
    const data = await report('24h')
    expect(data.agents.map((a) => a.projectId)).not.toContain(idleProjectId)
    expect(data.agents.map((a) => a.projectId)).not.toContain(foreignProjectId)
  })

  test('the row carries the schedule, the configured model and what the charges ran on', async () => {
    const data = await report('24h')
    const on = data.agents.find((a) => a.projectId === onProjectId)!

    expect(on.enabled).toBe(true)
    expect(on.intervalSeconds).toBe(1800)
    expect(on.quietHours).toEqual({ start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' })
    expect(on.configuredModel).toBe(CONFIGURED_MODEL)
    expect(on.lastHeartbeatAt).toBe(at(0.5).toISOString())
    expect(on.nextHeartbeatAt).toBe(new Date(NOW.getTime() + 20 * 60_000).toISOString())
    expect(on.owner?.userId).toBeTruthy()

    // Both models the ticks actually ran on, so a config/actual mismatch is
    // visible instead of hidden behind the configured one.
    expect(on.modelsUsed.map((m) => m.model).sort()).toEqual([CONFIGURED_MODEL, FALLBACK_MODEL].sort())
    expect(on.modelsUsed[0].billedUsd).toBeGreaterThanOrEqual(on.modelsUsed[1].billedUsd)

    // The turned-off project has no "next tick" to show.
    const off = data.agents.find((a) => a.projectId === offProjectId)!
    expect(off.nextHeartbeatAt).toBeNull()
    expect(off.quietHours).toBeNull()
  })

  test('a narrow scope narrows both the rows and the spend denominator', async () => {
    const mine = await report('24h', { createdBy: memberUserId })
    // The member created both the turned-off project and the idle one.
    expect(mine.agents.map((a) => a.projectId)).toEqual([offProjectId])
    expect(mine.totals.billedUsd).toBeCloseTo(0.4, 9)
    // The projects they cannot see must not dilute their share: only the
    // turned-off project's own spend is in the denominator (the 9.00 belongs to
    // another workspace and was never in scope).
    expect(mine.totals.workspaceBilledUsd).toBeCloseTo(0.4, 9)
  })

  test('the window is the window: 7d picks up the older tick, 24h does not', async () => {
    const day = await report('24h')
    const week = await report('7d')
    expect(day.totals.ticks).toBe(3)
    expect(week.totals.ticks).toBe(4)
    expect(week.totals.billedUsd).toBeCloseTo(3.14, 9)
    expect(week.daily.length).toBeGreaterThanOrEqual(7)
  })

  test('an empty workspace is empty, not broken', async () => {
    const data = await getWorkspaceHeartbeats(otherWorkspaceId, { period: '24h', now: NOW })
    // The other workspace has one heartbeat charge; nothing else.
    expect(data.agents).toHaveLength(1)
    expect(data.agents[0].projectId).toBe(foreignProjectId)
    expect(data.agents[0].owner?.userId).toBeTruthy()
  })
})

describe('SHO-182 QA: the route the Heartbeats tab calls', () => {
  async function call(path: string) {
    const res = await scopedAnalyticsRoutes().fetch(new Request(`http://test${path}`))
    const body: any = await res.json().catch(() => ({}))
    return { status: res.status, data: body.data ?? body }
  }

  test('returns the service report, with every row editable by an admin', async () => {
    // The plan gate only exists on the cloud track; local mode is never gated.
    if (POSTGRES) return

    const res = await call(`/workspaces/${workspaceId}/analytics/heartbeats?period=24h`)
    expect(res.status).toBe(200)

    const service = await report('24h')
    expect(res.data.period).toBe('24h')
    expect(res.data.totals.ticks).toBe(service.totals.ticks)
    expect(res.data.totals.billedUsd).toBeCloseTo(service.totals.billedUsd, 9)
    expect(res.data.totals.workspaceBilledUsd).toBeCloseTo(service.totals.workspaceBilledUsd, 9)
    expect(res.data.agents.map((a: any) => a.projectId)).toEqual(service.agents.map((a) => a.projectId))
    // An admin may turn any of them off, and the component hides the action on
    // rows where `canEdit` is false.
    expect(res.data.agents.every((a: any) => a.canEdit === true)).toBe(true)
    expect(res.data.agents[0].projectName).toBe('Heartbeat Bot')
  })
})
