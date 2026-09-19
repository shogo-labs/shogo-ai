// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import * as realInternalApi from '../internal-api'
import {
  createAgentProfileSetTool,
  createGoalCreateTool,
  createGoalLogTool,
  createGoalListTool,
  createGoalUpdateTool,
  createSetStatusTool,
} from '../workspace-agent-tools'

const calls: Array<{ name: string; args: unknown[] }> = []

mock.module('../internal-api', () => ({
  ...realInternalApi,
  setAgentProfile: async (...args: unknown[]) => {
    calls.push({ name: 'setAgentProfile', args })
    return { ok: true, status: 200, data: { statusText: 'Working', name: 'Shogo' } }
  },
  createGoal: async (...args: unknown[]) => {
    calls.push({ name: 'createGoal', args })
    return { ok: true, status: 201, data: { id: 'goal-1', title: 'Habit tracker' } }
  },
  updateGoal: async (...args: unknown[]) => {
    calls.push({ name: 'updateGoal', args })
    return { ok: true, status: 200, data: { id: 'goal-1', deliverables: args[2] } }
  },
  logGoalEvent: async (...args: unknown[]) => {
    calls.push({ name: 'logGoalEvent', args })
    return { ok: true, status: 201, data: { id: 'event-1', kind: 'progress' } }
  },
  listGoals: async (...args: unknown[]) => {
    calls.push({ name: 'listGoals', args })
    return { ok: true, status: 200, data: [{ id: 'goal-1', status: 'active' }] }
  },
}))

const ctx: any = {
  workspaceDir: '/tmp/workspace-agent-tools',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  channels: new Map(),
  config: { heartbeatInterval: 1800, heartbeatEnabled: true, quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' }, channels: [], model: { provider: 'anthropic', name: 'model' } },
}

async function execute(tool: any, params: Record<string, unknown> = {}) {
  const result = await tool.execute('call-1', params)
  return result.details
}

describe('personal runtime tools', () => {
  test('writes profile status and goal primitives through internal API', async () => {
    calls.length = 0
    await execute(createAgentProfileSetTool(ctx), { statusText: 'Working' })
    await execute(createSetStatusTool(ctx), { statusText: 'Working' })
    await execute(createGoalCreateTool(ctx), { title: 'Habit tracker' })
    await execute(createGoalUpdateTool(ctx), {
      goalId: 'goal-1',
      deliverables: [{ type: 'url', label: 'Tracker', href: 'https://example.com' }],
    })
    await execute(createGoalLogTool(ctx), { goalId: 'goal-1', kind: 'progress', message: 'Started' })

    expect(calls.map((call) => call.name)).toEqual([
      'setAgentProfile',
      'setAgentProfile',
      'createGoal',
      'updateGoal',
      'logGoalEvent',
    ])
    expect(calls[2]?.args[0]).toBe('workspace-1')
  })

  test('lists goals in workspace scope', async () => {
    calls.length = 0
    const result = await execute(createGoalListTool(ctx), { status: 'active' })
    expect(result.goals).toEqual([{ id: 'goal-1', status: 'active' }])
    expect(calls[0]).toEqual({ name: 'listGoals', args: ['workspace-1', 'active'] })
  })
})
