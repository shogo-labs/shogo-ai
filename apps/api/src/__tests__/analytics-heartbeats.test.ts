// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Workspace heartbeats (SHO-182) in src/services/analytics.service.ts.
//
// Two things are being pinned here:
//   1. Which charges count as a heartbeat. The session id is the only tag, it
//      has two shapes over time (`heartbeat` and `heartbeat:<projectId>:<id>`),
//      and a normal chat a person named `heartbeat-notes` must never be counted.
//   2. That both dialects agree. Postgres rolls the JSON up in SQL and SQLite
//      ships rows to Node, so the parity test runs one fixture through each and
//      requires a byte-identical response.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const db = {
  projects: [] as any[],
  configs: [] as any[],
  users: [] as any[],
  events: [] as any[],
}

const rawSql: string[] = []
const rawParams: unknown[][] = []
let rawRows: any[] = []

mock.module('../lib/prisma', () => {
  const prisma = {
    project: {
      findMany: async (args: any) => {
        const scope = args?.where?.AND?.[0]?.id?.in as string[] | undefined
        return db.projects.filter((p) => (scope ? scope.includes(p.id) : true))
      },
    },
    agentConfig: {
      findMany: async (args: any) => {
        const ids = args?.where?.projectId?.in as string[]
        return db.configs.filter((c) => ids.includes(c.projectId))
      },
    },
    user: {
      findMany: async (args: any) => {
        const ids = args?.where?.id?.in as string[]
        return db.users.filter((u) => ids.includes(u.id))
      },
    },
    usageEvent: {
      // Faithful enough to be worth testing against: the window and the metered
      // action types are what the query filters on.
      findMany: async (args: any) => {
        const gte = args?.where?.createdAt?.gte as Date | undefined
        const lt = args?.where?.createdAt?.lt as Date | undefined
        const types = args?.where?.actionType?.in as string[] | undefined
        return db.events.filter((e) =>
          (!gte || e.createdAt >= gte) && (!lt || e.createdAt < lt)
          && (!types || types.includes(e.actionType)))
      },
    },
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      rawSql.push(sql)
      rawParams.push(params)
      return rawRows
    },
  }
  return { prisma, default: prisma }
})

// The real module refreshes the catalog from the DB; here only the label matters.
mock.module('../services/model-registry.service', () => ({
  resolveModelLabels: async (ids: Iterable<string>) =>
    new Map([...ids].map((id) => [id, `label:${id}`])),
}))

const { getWorkspaceHeartbeats, parseHeartbeatPeriod } = await import('../services/analytics.service')

const WS = 'ws_1'
const NOW = new Date('2026-10-24T12:00:00.000Z')
const SAME_DAY = new Date('2026-10-24T06:00:00.000Z')

const event = (over: Record<string, any>) => ({
  projectId: null,
  billedUsd: 0,
  rawUsd: null,
  actionMetadata: {},
  createdAt: SAME_DAY,
  actionType: 'chat_message',
  ...over,
})

/** What a heartbeat turn writes: one row, tagged with the session it ran in. */
const heartbeatRow = (over: Record<string, any> = {}) =>
  event({
    projectId: 'p_heart',
    rawUsd: 1,
    actionMetadata: { model: 'm-haiku', chatSessionId: 'heartbeat', inputTokens: 100, outputTokens: 50 },
    ...over,
  })

function seed() {
  db.projects = [
    { id: 'p_heart', name: 'Heartbeat Heavy', createdBy: 'u_1' },
    { id: 'p_off', name: 'Switched Off', createdBy: 'u_2' },
    { id: 'p_idle', name: 'Idle Agent', createdBy: 'u_1' },
    { id: 'p_other', name: 'Chatty', createdBy: null },
  ]
  db.configs = [
    {
      projectId: 'p_heart',
      heartbeatEnabled: true,
      heartbeatInterval: 1800,
      nextHeartbeatAt: new Date('2026-10-24T12:30:00.000Z'),
      lastHeartbeatAt: new Date('2026-10-24T12:00:00.000Z'),
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
      quietHoursTimezone: 'America/Los_Angeles',
      modelName: 'model-uuid',
    },
    // Turned off after it spent: still must appear, marked off.
    {
      projectId: 'p_off',
      heartbeatEnabled: false,
      heartbeatInterval: 3600,
      nextHeartbeatAt: null,
      lastHeartbeatAt: null,
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
      modelName: 'model-uuid',
    },
    {
      projectId: 'p_idle',
      heartbeatEnabled: true,
      heartbeatInterval: 900,
      nextHeartbeatAt: new Date('2026-10-24T12:15:00.000Z'),
      lastHeartbeatAt: null,
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
      modelName: '',
    },
  ]
  db.users = [
    { id: 'u_1', name: 'Ada', email: 'ada@example.com' },
    { id: 'u_2', name: null, email: 'grace@example.com' },
  ]
  db.events = [
    // Two ticks under the shared pre-SHO-178 id, billed at provider cost.
    heartbeatRow(),
    heartbeatRow({ actionMetadata: { model: 'm-haiku', chatSessionId: 'heartbeat', totalTokens: 90 }, rawUsd: 1 }),
    // The per-tick shape names its own project (and was billed, not just costed).
    event({
      projectId: 'runtime_project',
      billedUsd: 3,
      rawUsd: 2.5,
      actionMetadata: {
        model: 'm-sonnet',
        chatSessionId: 'heartbeat:p_heart:tick_7',
        inputTokens: 10,
        outputTokens: 990,
      },
    }),
    // Off since, but spent inside the window.
    heartbeatRow({ projectId: 'p_off', rawUsd: 0.5 }),
    // A chat session a person named like a heartbeat. Not one.
    event({ projectId: 'p_other', rawUsd: 3, actionMetadata: { model: 'm-sonnet', chatSessionId: 'heartbeat-notes' } }),
    // A normal chat charge, there to give the denominator something to hold.
    event({ projectId: 'p_other', rawUsd: 1, actionMetadata: { model: 'm-sonnet' } }),
  ]
}

/** The rows Postgres returns for `seed()` — (day, project, heartbeat?, model) groups. */
function seededSqlRows() {
  const day = new Date(Date.UTC(2026, 9, 24))
  return [
    { day, projectId: 'p_heart', heartbeat: true, model: 'm-haiku', charges: 2, billedUsd: 2, rawUsd: 2, totalTokens: 240 },
    // Already attributed by the SQL: the row's own project was `runtime_project`,
    // the `heartbeat:<projectId>:` session named p_heart.
    { day, projectId: 'p_heart', heartbeat: true, model: 'm-sonnet', charges: 1, billedUsd: 3, rawUsd: 2.5, totalTokens: 1000 },
    { day, projectId: 'p_off', heartbeat: true, model: 'm-haiku', charges: 1, billedUsd: 0.5, rawUsd: 0.5, totalTokens: 150 },
    { day, projectId: 'p_other', heartbeat: false, model: 'm-sonnet', charges: 2, billedUsd: 4, rawUsd: 4, totalTokens: 0 },
  ]
}

beforeEach(() => {
  seed()
  rawSql.length = 0
  rawParams.length = 0
  rawRows = seededSqlRows()
  process.env.SHOGO_LOCAL_MODE = 'true'
})

const node = () => getWorkspaceHeartbeats(WS, { period: '24h', now: NOW })

describe('getWorkspaceHeartbeats — SQLite (rows rolled up in Node)', () => {
  test('counts both heartbeat session shapes and nothing that merely looks like one', async () => {
    const data = await node()

    // 2 ticks under `heartbeat` for p_heart, 1 under `heartbeat:p_heart:tick_7`,
    // and 1 for the project that was switched off after it spent. `heartbeat-notes`
    // is a chat, so it is not a tick.
    expect(data.totals.ticks).toBe(4)
    expect(data.totals.billedUsd).toBe(5.5)
    // ...and heartbeat + other = every metered charge in the window.
    expect(data.totals.workspaceBilledUsd).toBe(9.5)
  })

  test('the per-tick session id is attributed to the project it names, not the billing project', async () => {
    const data = await node()
    const heavy = data.agents.find((a) => a.projectId === 'p_heart')

    // The SHO-178 row landed on `runtime_project` but names p_heart.
    expect(heavy?.ticks).toBe(3)
    expect(heavy?.billedUsd).toBe(5)
    expect(data.agents.some((a) => a.projectId === 'runtime_project')).toBe(false)
  })

  test('one row per agent with its schedule, owner, quiet hours and average per tick', async () => {
    const data = await node()
    const heavy = data.agents.find((a) => a.projectId === 'p_heart')

    expect(heavy).toMatchObject({
      projectName: 'Heartbeat Heavy',
      owner: { userId: 'u_1', name: 'Ada', email: 'ada@example.com' },
      enabled: true,
      intervalSeconds: 1800,
      quietHours: { start: '22:00', end: '06:00', timezone: 'America/Los_Angeles' },
      lastHeartbeatAt: '2026-10-24T12:00:00.000Z',
      nextHeartbeatAt: '2026-10-24T12:30:00.000Z',
      configuredModel: 'model-uuid',
      configuredModelLabel: 'label:model-uuid',
      totalTokens: 240 + 1000,
      canEdit: false,
    })
    expect(heavy!.billedUsd / heavy!.ticks).toBeCloseTo(heavy!.avgUsdPerTick!, 10)
    expect(heavy!.avgUsdPerTick).toBeCloseTo(5 / 3, 10)
  })

  test('shows what the charges actually ran on, next to the configured model', async () => {
    const data = await node()
    const heavy = data.agents.find((a) => a.projectId === 'p_heart')!

    // The config says model-uuid; the charges say otherwise — that is the point.
    expect(heavy.configuredModel).toBe('model-uuid')
    expect(heavy.modelsUsed.map((m) => m.model)).toEqual(['m-sonnet', 'm-haiku'])
    expect(heavy.modelsUsed[0].billedUsd).toBe(3)
  })

  test('a project switched off since it spent is still shown, marked off', async () => {
    const data = await node()
    const off = data.agents.find((a) => a.projectId === 'p_off')

    expect(off).toMatchObject({ enabled: false, ticks: 1, billedUsd: 0.5, nextHeartbeatAt: null })
    // Its owner has no name, only an email — the row is still labelled.
    expect(off?.owner).toEqual({ userId: 'u_2', name: null, email: 'grace@example.com' })
    expect(data.totals.agentsEnabled).toBe(2)
    expect(data.totals.agentsWithSpend).toBe(2)
  })

  test('a heartbeat with no charges still gets a row', async () => {
    const data = await node()
    expect(data.agents.find((a) => a.projectId === 'p_idle')).toMatchObject({
      enabled: true,
      ticks: 0,
      billedUsd: 0,
      avgUsdPerTick: null,
      configuredModelLabel: null,
    })
  })

  test('a project with no heartbeat and no heartbeat spend never appears', async () => {
    const data = await node()
    expect(data.agents.some((a) => a.projectId === 'p_other')).toBe(false)
  })

  test('rows come back highest spend first', async () => {
    const data = await node()
    expect(data.agents.map((a) => a.projectId)).toEqual(['p_heart', 'p_off', 'p_idle'])
  })

  test('the daily series splits heartbeat from everything else and zero-fills gaps', async () => {
    const data = await node()

    // 24h from 2026-10-24T12:00Z starts on the 23rd.
    expect(data.daily.map((d) => d.date)).toEqual(['2026-10-23', '2026-10-24'])
    expect(data.daily[0]).toEqual({ date: '2026-10-23', heartbeatUsd: 0, otherUsd: 0 })
    expect(data.daily[1]).toEqual({ date: '2026-10-24', heartbeatUsd: 5.5, otherUsd: 4 })
    // ...and the split adds back to the workspace total.
    const sum = data.daily.reduce((acc, d) => acc + d.heartbeatUsd + d.otherUsd, 0)
    expect(sum).toBeCloseTo(data.totals.workspaceBilledUsd, 10)
  })

  test('a member scope narrows the rows and the spend denominator with them', async () => {
    const data = await getWorkspaceHeartbeats(WS, {
      period: '24h',
      now: NOW,
      projectWhere: { id: { in: ['p_heart'] } },
    })

    expect(data.agents.map((a) => a.projectId)).toEqual(['p_heart'])
    expect(data.totals.ticks).toBe(3)
    // Chatty's $4 is out of the denominator, not just out of the table.
    expect(data.totals.workspaceBilledUsd).toBe(5)
  })

  test('an older row outside the window is ignored', async () => {
    db.events.push(heartbeatRow({ createdAt: new Date('2026-10-01T00:00:00.000Z'), rawUsd: 99 }))
    const data = await node()
    expect(data.totals.ticks).toBe(4)
    expect(data.totals.billedUsd).toBe(5.5)
  })

  test('reads the window the period asks for', async () => {
    const week = await getWorkspaceHeartbeats(WS, { period: '7d', now: NOW })
    expect(week.period).toBe('7d')
    expect(week.daily).toHaveLength(8)
    expect(week.window.to).toBe(NOW.toISOString())
  })
})

describe('getWorkspaceHeartbeats — Postgres (JSON rolled up in SQL)', () => {
  beforeEach(() => {
    delete process.env.SHOGO_LOCAL_MODE
  })

  test('matches heartbeat sessions on the exact id or the prefix, never a lookalike', async () => {
    await node()
    const sql = rawSql[0] ?? ''

    expect(sql).toContain(`COALESCE("actionMetadata"->>'chatSessionId', '') = 'heartbeat'`)
    expect(sql).toContain(`LIKE 'heartbeat:%'`)
    // Postgres does the JSON work; the window's actionMetadata never ships.
    expect(sql).toContain('jsonb_typeof')
    expect(db.events.length).toBeGreaterThan(0)
  })

  test('attributes a per-tick session id to the project it names', async () => {
    await node()
    const sql = rawSql[0] ?? ''
    expect(sql).toContain(`split_part(`)
    expect(sql).toContain(`COALESCE(CASE WHEN`)
  })

  test('binds the workspace, the window and the metered action types', async () => {
    await node()
    const params = rawParams[0] ?? []

    expect(params).toContain(WS)
    expect(params.some((p) => p instanceof Date)).toBe(true)
    expect(params).toContain('chat_message')
    // No value is ever interpolated into the statement.
    expect(rawSql[0]).not.toContain(WS)
  })

  test('produces exactly what the SQLite path produces from the same charges', async () => {
    const postgres = await node()
    process.env.SHOGO_LOCAL_MODE = 'true'
    const sqlite = await node()

    expect(postgres).toEqual(sqlite)
  })

  test('a driver handing back a timestamp string keeps the day bucket', async () => {
    rawRows = seededSqlRows().map((row) => ({ ...row, day: '2026-10-24 00:00:00+00' }))
    const data = await node()
    expect(data.daily.find((d) => d.heartbeatUsd > 0)?.date).toBe('2026-10-24')
  })

  test('is empty, not broken, when the window has no charges', async () => {
    rawRows = []
    const data = await node()
    expect(data.totals).toMatchObject({ ticks: 0, billedUsd: 0, workspaceBilledUsd: 0 })
    // The two heartbeats that are still on: no spend, but the admin still sees them.
    expect(data.agents.map((a) => a.projectId)).toEqual(['p_heart', 'p_idle'])
  })
})

describe('parseHeartbeatPeriod', () => {
  test('accepts the three periods the tab offers', () => {
    expect(parseHeartbeatPeriod('24h')).toBe('24h')
    expect(parseHeartbeatPeriod('7d')).toBe('7d')
    expect(parseHeartbeatPeriod('30d')).toBe('30d')
  })

  test('falls back to 24h on anything else', () => {
    for (const raw of [null, undefined, '', '90d', 'forever', '1d', 42]) {
      expect(parseHeartbeatPeriod(raw)).toBe('24h')
    }
  })
})

describe('one heartbeat tick writes one usage row', () => {
  test('records exactly one charge per turn, so "ticks" is a count of rows', async () => {
    const usageEvents: any[] = []
    mock.module('../services/billing-local', () => ({
      recordLocalUsage: async (params: any) => {
        usageEvents.push(params)
        return { success: true, remainingIncludedUsd: Infinity, overageChargedUsd: 0, source: 'daily' }
      },
    }))
    mock.module('../services/cost-analytics.service', () => ({
      recordAgentCostMetric: async () => {},
    }))
    const { recordLocalTurnUsage } = await import('../lib/local-turn-usage')

    // Cloud does the same thing per turn: `closeSession` writes one event.
    const result = await recordLocalTurnUsage({
      workspaceId: WS,
      projectId: 'p_heart',
      userId: 'u_1',
      chatSessionId: 'heartbeat',
      usage: { model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 500 },
      requestCount: 4,
    })

    expect(result.totalTokens).toBe(1500)
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].actionMetadata.chatSessionId).toBe('heartbeat')

    // And the report reads it back as one tick.
    db.events = [event({
      projectId: 'p_heart',
      rawUsd: result.rawUsd,
      actionMetadata: { ...usageEvents[0].actionMetadata },
    })]
    process.env.SHOGO_LOCAL_MODE = 'true'
    const data = await node()
    expect(data.totals.ticks).toBe(1)
    expect(data.agents[0].avgUsdPerTick).toBeCloseTo(result.rawUsd, 10)
  })
})
