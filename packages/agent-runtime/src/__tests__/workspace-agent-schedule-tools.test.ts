// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'

const calls: Array<{ name: string; args: unknown[] }> = []

mock.module('../gateway-tools', () => ({
  textResult: (details: unknown) => ({ details }),
}))

mock.module('../permission-engine', () => ({
  assertWithinWorkspace: (_workspaceDir: string, relativePath: string) => relativePath,
}))

mock.module('../internal-api', () => ({
  createGoal: async () => ({ ok: true, status: 201, data: {} }),
  createSchedule: async (...args: unknown[]) => {
    calls.push({ name: 'createSchedule', args })
    return { ok: true, status: 201, data: { id: 'schedule-1', enabled: true } }
  },
  listSchedules: async (...args: unknown[]) => {
    calls.push({ name: 'listSchedules', args })
    return { ok: true, status: 200, data: [{ id: 'schedule-1', enabled: true }] }
  },
  updateSchedule: async (...args: unknown[]) => {
    calls.push({ name: 'updateSchedule', args })
    return { ok: true, status: 200, data: { id: 'schedule-1', enabled: false } }
  },
  deleteSchedule: async (...args: unknown[]) => {
    calls.push({ name: 'deleteSchedule', args })
    return { ok: true, status: 200, data: { ok: true } }
  },
  getAgentProfile: async () => ({ ok: true, status: 200, data: {} }),
  listGoals: async () => ({ ok: true, status: 200, data: [] }),
  logGoalEvent: async () => ({ ok: true, status: 201, data: {} }),
  setAgentProfile: async () => ({ ok: true, status: 200, data: {} }),
  updateGoal: async () => ({ ok: true, status: 200, data: {} }),
  uploadAgentAvatar: async () => ({ ok: true, status: 200, data: {} }),
}))

const {
  createScheduleCreateTool,
  createScheduleDeleteTool,
  createScheduleListTool,
  createScheduleUpdateTool,
} = await import('../workspace-agent-tools')

const ctx: any = { workspaceId: 'workspace-1', userId: 'user-1', workspaceDir: '/tmp' }

async function execute(tool: any, params: Record<string, unknown>) {
  return (await tool.execute('call-1', params)).details
}

describe('workspace schedule tools', () => {
  test('maps schedule tool calls to the internal API', async () => {
    calls.length = 0
    await execute(createScheduleCreateTool(ctx), {
      name: 'Morning digest',
      prompt: 'Review the inbox.',
      cron: '0 9 * * 1-5',
      timezone: 'America/Los_Angeles',
      goalId: 'goal-1',
    })
    await execute(createScheduleListTool(ctx), { goalId: 'goal-1' })
    await execute(createScheduleUpdateTool(ctx), { scheduleId: 'schedule-1', enabled: false })
    await execute(createScheduleDeleteTool(ctx), { scheduleId: 'schedule-1' })

    expect(calls.map((call) => call.name)).toEqual([
      'createSchedule',
      'listSchedules',
      'updateSchedule',
      'deleteSchedule',
    ])
    expect(calls[0]?.args[0]).toBe('workspace-1')
    expect(calls[0]?.args[1]).toMatchObject({
      cronExpression: '0 9 * * 1-5',
      userId: 'user-1',
    })
    expect(calls[1]?.args).toEqual(['workspace-1', 'goal-1'])
    expect(calls[3]?.args).toEqual(['workspace-1', 'schedule-1'])
  })
})
