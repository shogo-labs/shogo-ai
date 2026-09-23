// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'

mock.module('../../lib/prisma', () => ({
  prisma: {
    agentSchedule: {
      count: mock(async () => 0),
      findMany: mock(async () => []),
      findFirst: mock(async () => null),
      create: mock(async (args: any) => args.data),
      update: mock(async (args: any) => args.data),
      deleteMany: mock(async () => ({ count: 1 })),
    },
    goal: {
      findFirst: mock(async () => ({ id: 'goal-1' })),
    },
  },
}))

const {
  MIN_AGENT_SCHEDULE_INTERVAL_MS,
  nextCronRuns,
  nextAgentScheduleRun,
} = await import('../agent-schedule.service')

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
    expect(() => nextCronRuns('* * * * *', 'UTC')).toThrow(/five minutes/)
    expect(MIN_AGENT_SCHEDULE_INTERVAL_MS).toBe(300_000)
  })

  test('rejects invalid cron fields and timezones', () => {
    expect(() => nextCronRuns('0 9 * *', 'UTC')).toThrow(/five fields/)
    expect(() => nextCronRuns('0 9 * * *', 'Not/A_Timezone')).toThrow(/Unknown timezone/)
  })
})
