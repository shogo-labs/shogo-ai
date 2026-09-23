// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const count = mock(async (_args: any) => 0)
const findFirst = mock(async (_args: any): Promise<any> => null)
const create = mock(async (args: any) => args.data)
const update = mock(async (args: any) => args.data)

mock.module('../../lib/prisma', () => ({
  prisma: {
    agentSchedule: {
      count,
      findMany: mock(async () => []),
      findFirst,
      create,
      update,
      deleteMany: mock(async () => ({ count: 1 })),
    },
    goal: {
      findFirst: mock(async () => ({ id: 'goal-1' })),
    },
  },
}))

const {
  MAX_AGENT_SCHEDULES,
  MAX_TOTAL_AGENT_SCHEDULES,
  MIN_AGENT_SCHEDULE_INTERVAL_MS,
  createSchedule,
  nextCronRuns,
  nextAgentScheduleRun,
  updateSchedule,
  validateAgentSchedule,
} = await import('../agent-schedule.service')

const draft = {
  workspaceId: 'workspace-1',
  userId: 'user-1',
  name: 'Morning digest',
  prompt: 'Review the inbox.',
  cronExpression: '0 9 * * 1-5',
  timezone: 'America/Los_Angeles',
}

describe('agent schedule cron validation', () => {
  test('computes timezone-aware future occurrences', () => {
    const runs = nextCronRuns(
      '0 9 * * 1-5',
      'America/Los_Angeles',
      new Date('2026-09-22T00:00:00.000Z'),
    )

    expect(runs[0]?.toISOString()).toBe('2026-09-22T16:00:00.000Z')
    expect(runs[1]?.toISOString()).toBe('2026-09-23T16:00:00.000Z')
    expect(nextAgentScheduleRun('0 9 * * 1-5', 'America/Los_Angeles', new Date('2026-09-22T00:00:00.000Z')))
      .toEqual(runs[0])
  })

  test('rejects expressions that run more often than every five minutes', () => {
    expect(() => validateAgentSchedule('* * * * *', 'UTC')).toThrow(/five minutes/)
    expect(MIN_AGENT_SCHEDULE_INTERVAL_MS).toBe(300_000)
  })

  test('rejects a too-frequent pair regardless of when validation runs', () => {
    const hour = Date.parse('2026-09-22T10:00:00.000Z')
    for (const offsetSeconds of [0, 30, 59, 60, 61, 90, 30 * 60, 59 * 60 + 59]) {
      const from = new Date(hour + offsetSeconds * 1000)
      expect(() => validateAgentSchedule('0,1 * * * *', 'UTC', from)).toThrow(/five minutes/)
    }
    // Only the 23:59 -> 00:00 boundary on the 31st/1st is too close.
    expect(() =>
      validateAgentSchedule('0,59 0,23 1,31 * *', 'UTC', new Date('2026-09-02T00:00:00.000Z')),
    ).toThrow(/five minutes/)
  })

  test('the dispatcher-side next run ignores cadence limits', () => {
    const from = new Date('2026-09-22T10:00:30.000Z')
    expect(nextAgentScheduleRun('0,1 * * * *', 'UTC', from).toISOString()).toBe('2026-09-22T10:01:00.000Z')
  })

  test('rejects invalid cron fields and timezones', () => {
    expect(() => nextCronRuns('0 9 * *', 'UTC')).toThrow(/five fields/)
    expect(() => nextCronRuns('0 9 * * *', 'Not/A_Timezone')).toThrow(/Unknown timezone/)
    expect(() => nextAgentScheduleRun('not a cron at all', 'UTC')).toThrow()
  })
})

describe('agent schedule persistence', () => {
  beforeEach(() => {
    count.mockReset()
    count.mockImplementation(async () => 0)
    findFirst.mockReset()
    create.mockClear()
    update.mockClear()
  })

  test('enforces the enabled-schedule cap', async () => {
    count.mockImplementation(async (args: any) => (args?.where?.enabled ? MAX_AGENT_SCHEDULES : 0))
    await expect(createSchedule(draft)).rejects.toMatchObject({ code: 'schedule_limit_reached' })
    expect(create).not.toHaveBeenCalled()
  })

  test('enforces a total cap that includes disabled schedules', async () => {
    count.mockImplementation(async (args: any) => (args?.where?.enabled ? 0 : MAX_TOTAL_AGENT_SCHEDULES))
    await expect(createSchedule({ ...draft, enabled: false }))
      .rejects.toMatchObject({ code: 'schedule_limit_reached', status: 409 })
    expect(create).not.toHaveBeenCalled()
  })

  test('creates a schedule under the caps', async () => {
    const created = await createSchedule(draft)
    expect(created).toMatchObject({ enabled: true, cronExpression: '0 9 * * 1-5' })
    expect(created.nextRunAt).toBeInstanceOf(Date)
  })

  test('re-enabling or changing cadence during a run keeps the run lease', async () => {
    const runningAt = new Date('2026-09-22T16:00:00.000Z')
    findFirst.mockImplementation(async () => ({
      id: 'schedule-1',
      ...draft,
      enabled: false,
      runningAt,
      consecutiveFailures: 5,
    }))

    await updateSchedule('workspace-1', 'schedule-1', { enabled: true, cronExpression: '30 9 * * 1-5' })

    const data = update.mock.calls[0]?.[0]?.data
    expect(data).not.toHaveProperty('runningAt')
    expect(data.nextRunAt).toBeInstanceOf(Date)
    expect(data.consecutiveFailures).toBe(0)
  })
})
