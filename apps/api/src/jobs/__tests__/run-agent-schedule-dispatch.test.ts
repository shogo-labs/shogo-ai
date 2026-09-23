// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const dueSchedule = {
  id: 'schedule-1',
  workspaceId: 'workspace-1',
  goalId: null,
  userId: 'user-1',
  name: 'Morning digest',
  prompt: 'Review the inbox.',
  cronExpression: '0 9 * * 1-5',
  timezone: 'America/Los_Angeles',
  enabled: true,
  nextRunAt: new Date('2026-09-22T16:00:00.000Z'),
  runningAt: null,
  chatSessionId: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
}

const updateMany = mock(async () => ({ count: 0 }))
const findMany = mock(async () => [dueSchedule])

mock.module('../../lib/prisma', () => ({
  prisma: {
    agentSchedule: {
      findMany,
      updateMany,
      findUnique: mock(async () => null),
      update: mock(async () => dueSchedule),
    },
    chatSession: {
      create: mock(async () => ({ id: 'session-1' })),
      findUnique: mock(async () => null),
    },
    chatMessage: {
      findFirst: mock(async () => null),
    },
  },
}))

mock.module('../../lib/region', () => ({
  homeRegionWorkspaceWhere: () => null,
}))

mock.module('../../services/agent-schedule.service', () => ({
  nextAgentScheduleRun: () => new Date('2026-09-23T16:00:00.000Z'),
}))

const workspaceChatRoutes = mock(() => ({ fetch: mock(async () => new Response(null, { status: 200 })) }))
mock.module('../../routes/workspace-chat', () => ({ workspaceChatRoutes }))

const { dispatchDueSchedules } = await import('../run-agent-schedule-dispatch')

describe('agent schedule dispatcher', () => {
  beforeEach(() => {
    findMany.mockClear()
    updateMany.mockClear()
  })

  test('uses an atomic claim before starting a workspace turn', async () => {
    await dispatchDueSchedules()

    expect(findMany).toHaveBeenCalledTimes(1)
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
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
})
