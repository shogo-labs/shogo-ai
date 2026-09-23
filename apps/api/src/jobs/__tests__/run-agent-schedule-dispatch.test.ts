// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const claimedAt = new Date('2026-09-22T16:00:05.000Z')

const dueSchedule = {
  id: 'schedule-1',
  workspaceId: 'workspace-1',
  goalId: null as string | null,
  userId: 'user-1',
  name: 'Morning digest',
  prompt: 'Review the inbox.',
  cronExpression: '0 9 * * 1-5',
  timezone: 'America/Los_Angeles',
  enabled: true,
  nextRunAt: new Date('2026-09-22T16:00:00.000Z'),
  runningAt: null as Date | null,
  consecutiveFailures: 0,
  chatSessionId: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
}

type Row = typeof dueSchedule & { goal?: { title: string; status: string } | null }

let claimedRow: Row = { ...dueSchedule, runningAt: claimedAt, goal: null }

const updateMany = mock(async (_args: any) => ({ count: 1 }))
const findMany = mock(async (_args: any): Promise<Row[]> => [dueSchedule])
const findUnique = mock(async () => claimedRow)
const assistantMessage = mock(async (): Promise<{ content: string } | null> => null)

mock.module('../../lib/prisma', () => ({
  prisma: {
    agentSchedule: {
      findMany,
      updateMany,
      findUnique,
      update: mock(async () => dueSchedule),
    },
    chatSession: {
      create: mock(async () => ({ id: 'session-1' })),
      findUnique: mock(async () => null),
    },
    chatMessage: {
      findFirst: assistantMessage,
    },
  },
}))

mock.module('../../lib/region', () => ({
  homeRegionWorkspaceWhere: () => null,
}))

mock.module('../../services/agent-schedule.service', () => ({
  nextAgentScheduleRun: (cronExpression: string) => {
    if (cronExpression === 'not a cron') throw new Error('Invalid cron expression')
    return new Date('2026-09-23T16:00:00.000Z')
  },
}))

const chatFetch = mock(async (_request: Request): Promise<Response> => new Response(null, { status: 200 }))
const workspaceChatRoutes = mock(() => ({ fetch: chatFetch }))
mock.module('../../routes/workspace-chat', () => ({ workspaceChatRoutes }))

const { dispatchDueSchedules, waitForAgentScheduleRuns } = await import('../run-agent-schedule-dispatch')

function claimCalls() {
  return updateMany.mock.calls.filter((call) => call[0]?.data?.lastRunStatus === 'running')
}

function resultUpdate() {
  const calls = updateMany.mock.calls.filter((call) => call[0]?.data?.lastRunStatus !== 'running')
  return calls[calls.length - 1]?.[0]
}

async function dispatchAndWait() {
  await dispatchDueSchedules()
  await waitForAgentScheduleRuns()
}

describe('agent schedule dispatcher', () => {
  beforeEach(() => {
    claimedRow = { ...dueSchedule, runningAt: claimedAt, goal: null }
    findMany.mockReset()
    findMany.mockImplementation(async () => [dueSchedule])
    updateMany.mockReset()
    updateMany.mockImplementation(async () => ({ count: 1 }))
    findUnique.mockClear()
    assistantMessage.mockReset()
    assistantMessage.mockImplementation(async () => null)
    chatFetch.mockReset()
    chatFetch.mockImplementation(async () => new Response(null, { status: 200 }))
    workspaceChatRoutes.mockClear()
  })

  test('uses an atomic claim before starting a workspace turn', async () => {
    findUnique.mockImplementationOnce(async () => null as any)
    await dispatchAndWait()

    expect(findMany).toHaveBeenCalledTimes(1)
    expect(claimCalls()).toHaveLength(1)
    expect(claimCalls()[0]?.[0]).toMatchObject({
      where: {
        id: 'schedule-1',
        enabled: true,
        nextRunAt: dueSchedule.nextRunAt,
      },
      data: {
        lastRunStatus: 'running',
      },
    })
    expect(workspaceChatRoutes).not.toHaveBeenCalled()
  })

  test('does not start a run when another replica wins the claim', async () => {
    updateMany.mockImplementation(async () => ({ count: 0 }))
    await dispatchAndWait()
    expect(findUnique).not.toHaveBeenCalled()
    expect(chatFetch).not.toHaveBeenCalled()
  })

  test('persists ok and the assistant summary after a successful run', async () => {
    assistantMessage.mockImplementation(async () => ({ content: '  Inbox reviewed: 2 urgent threads.  ' }))
    await dispatchAndWait()

    expect(chatFetch).toHaveBeenCalledTimes(1)
    const request = chatFetch.mock.calls[0]?.[0] as Request
    expect(request.headers.get('X-Schedule-User-Id')).toBe('user-1')
    expect(resultUpdate()).toMatchObject({
      where: { id: 'schedule-1', runningAt: claimedAt },
      data: {
        lastRunStatus: 'ok',
        lastRunSummary: 'Inbox reviewed: 2 urgent threads.',
        lastError: null,
        consecutiveFailures: 0,
        runningAt: null,
      },
    })
  })

  test('persists failed with the error and increments the failure count', async () => {
    chatFetch.mockImplementation(async () =>
      Response.json({ error: { message: 'Runtime unavailable' } }, { status: 503 }))
    await dispatchAndWait()

    const update = resultUpdate()
    expect(update).toMatchObject({
      where: { id: 'schedule-1', runningAt: claimedAt },
      data: {
        lastRunStatus: 'failed',
        lastError: 'Runtime unavailable',
        consecutiveFailures: 1,
        runningAt: null,
      },
    })
    expect(update.data).not.toHaveProperty('enabled')
  })

  test('auto-disables after repeated consecutive failures', async () => {
    claimedRow = { ...claimedRow, consecutiveFailures: 4 }
    chatFetch.mockImplementation(async () => new Response('boom', { status: 500 }))
    await dispatchAndWait()

    expect(resultUpdate()?.data).toMatchObject({
      enabled: false,
      lastRunStatus: 'failed',
      consecutiveFailures: 5,
    })
    expect(resultUpdate()?.data.lastError).toMatch(/Disabled after 5 consecutive failed runs/)
  })

  test('disables immediately when the creator is no longer authorized', async () => {
    chatFetch.mockImplementation(async () =>
      Response.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, { status: 403 }))
    await dispatchAndWait()

    expect(resultUpdate()?.data).toMatchObject({ enabled: false, consecutiveFailures: 1 })
    expect(resultUpdate()?.data.lastError).toMatch(/HTTP 403/)
  })

  test('only queries schedules without a goal or with an active goal', async () => {
    await dispatchAndWait()
    expect(findMany.mock.calls[0]?.[0]?.where?.AND).toContainEqual({
      OR: [{ goalId: null }, { goal: { status: 'active' } }],
    })
  })

  test('skips a claimed schedule whose goal is paused or done', async () => {
    for (const status of ['paused', 'done']) {
      updateMany.mockClear()
      chatFetch.mockClear()
      claimedRow = { ...claimedRow, goalId: 'goal-1', goal: { title: 'Launch', status } }
      await dispatchAndWait()

      expect(chatFetch).not.toHaveBeenCalled()
      expect(resultUpdate()).toMatchObject({
        where: { id: 'schedule-1', runningAt: claimedAt },
        data: { lastRunStatus: 'skipped', runningAt: null },
      })
    }
  })

  test('reclaims a schedule whose lease went stale', async () => {
    const before = Date.now()
    const stale = { ...dueSchedule, runningAt: new Date(before - 10 * 60_000) }
    findMany.mockImplementation(async () => [stale])
    await dispatchAndWait()

    const claim = claimCalls()[0]?.[0]
    const staleBefore: Date = claim.where.OR[1].runningAt.lt
    expect(claim.where.OR[0]).toEqual({ runningAt: null })
    expect(staleBefore.getTime()).toBeGreaterThan(stale.runningAt.getTime())
    expect(staleBefore.getTime()).toBeLessThanOrEqual(before)
    expect(chatFetch).toHaveBeenCalledTimes(1)
  })

  test('disables a schedule whose stored expression cannot be parsed', async () => {
    findMany.mockImplementation(async () => [{ ...dueSchedule, cronExpression: 'not a cron' }])
    await dispatchAndWait()

    expect(claimCalls()).toHaveLength(0)
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'schedule-1', nextRunAt: dueSchedule.nextRunAt },
      data: { enabled: false, lastRunStatus: 'failed', runningAt: null },
    })
    expect(chatFetch).not.toHaveBeenCalled()
  })

  test('caps concurrent in-flight runs per process', async () => {
    const release: Array<() => void> = []
    chatFetch.mockImplementation(() =>
      new Promise<Response>((resolve) => release.push(() => resolve(new Response(null, { status: 200 })))))
    findMany.mockImplementation(async (args: any) =>
      Array.from({ length: args.take }, (_, i) => ({ ...dueSchedule, id: `schedule-${i}` })))

    await dispatchDueSchedules()
    expect(findMany.mock.calls[0]?.[0]?.take).toBe(10)
    await new Promise((resolve) => setTimeout(resolve, 10))

    await dispatchDueSchedules()
    expect(findMany).toHaveBeenCalledTimes(1)

    release.forEach((resolve) => resolve())
    await waitForAgentScheduleRuns()
  })
})
