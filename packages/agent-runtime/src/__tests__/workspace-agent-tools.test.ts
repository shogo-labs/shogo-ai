// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, mock, test } from 'bun:test'
import * as realInternalApi from '../internal-api'
import {
  createAgentProfileSetTool,
  createGoalCreateTool,
  createGoalLogTool,
  createGoalListTool,
  createGoalUpdateTool,
  createScheduleCreateTool,
  createScheduleDeleteTool,
  createScheduleListTool,
  createScheduleUpdateTool,
  createSetStatusTool,
} from '../workspace-agent-tools'

const calls: Array<{ name: string; args: unknown[] }> = []

mock.module('../internal-api', () => ({
  ...realInternalApi,
  setAgentProfile: async (...args: unknown[]) => {
    calls.push({ name: 'setAgentProfile', args })
    return { ok: true, status: 200, data: { statusText: 'Working', name: 'Shogo' } }
  },
  uploadAgentAvatar: async (...args: unknown[]) => {
    calls.push({ name: 'uploadAgentAvatar', args })
    return { ok: true, status: 200, data: { avatarUrl: 'https://artifacts.example.com/avatars/workspace-1.png' } }
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
  createSchedule: async (...args: unknown[]) => {
    calls.push({ name: 'createSchedule', args })
    return { ok: true, status: 201, data: { id: 'schedule-1', name: 'Morning digest' } }
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
}))

const WORKSPACE_DIR = join('/tmp', `workspace-agent-tools-${Date.now()}`)
mkdirSync(join(WORKSPACE_DIR, 'images'), { recursive: true })
writeFileSync(join(WORKSPACE_DIR, 'images', 'avatar.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
afterAll(() => rmSync(WORKSPACE_DIR, { recursive: true, force: true }))

const ctx: any = {
  workspaceDir: WORKSPACE_DIR,
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

  test('creates, lists, updates, and deletes workspace schedules', async () => {
    calls.length = 0
    await execute(createScheduleCreateTool({ ...ctx, userId: 'user-1' }), {
      name: 'Morning digest',
      prompt: 'Review my inbox and summarize anything urgent.',
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
    expect(calls[0]?.args).toEqual([
      'workspace-1',
      {
        name: 'Morning digest',
        prompt: 'Review my inbox and summarize anything urgent.',
        cronExpression: '0 9 * * 1-5',
        timezone: 'America/Los_Angeles',
        goalId: 'goal-1',
        enabled: undefined,
        userId: 'user-1',
      },
    ])
    expect(calls[1]?.args).toEqual(['workspace-1', 'goal-1'])
    expect(calls[2]?.args).toEqual(['workspace-1', 'schedule-1', {
      name: undefined,
      prompt: undefined,
      cronExpression: undefined,
      timezone: undefined,
      goalId: undefined,
      enabled: false,
    }])
    expect(calls[3]?.args).toEqual(['workspace-1', 'schedule-1'])
  })
})

describe('agent_profile_set avatarImagePath', () => {
  test('uploads a generated workspace image and skips a redundant setAgentProfile call', async () => {
    calls.length = 0
    const result = await execute(createAgentProfileSetTool(ctx), { avatarImagePath: 'images/avatar.png' })
    expect(calls.map((call) => call.name)).toEqual(['uploadAgentAvatar'])
    expect(calls[0]?.args[0]).toBe('workspace-1')
    expect(result.profile.avatarUrl).toBe('https://artifacts.example.com/avatars/workspace-1.png')
  })

  test('uploads the avatar and also applies other profile fields in one call', async () => {
    calls.length = 0
    await execute(createAgentProfileSetTool(ctx), { avatarImagePath: 'images/avatar.png', name: 'Nova' })
    expect(calls.map((call) => call.name)).toEqual(['uploadAgentAvatar', 'setAgentProfile'])
    expect(calls[1]?.args[1]).toEqual({ name: 'Nova' })
  })

  test('errors when the referenced image does not exist', async () => {
    calls.length = 0
    const result = await execute(createAgentProfileSetTool(ctx), { avatarImagePath: 'images/missing.png' })
    expect(calls).toHaveLength(0)
    expect(result.code).toBe('not_found')
  })

  test('rejects a path outside the workspace', async () => {
    calls.length = 0
    const result = await execute(createAgentProfileSetTool(ctx), { avatarImagePath: '../outside.png' })
    expect(calls).toHaveLength(0)
    expect(result.code).toBe('invalid_path')
  })

  test('falls back to a plain avatarUrl when no avatarImagePath is given', async () => {
    calls.length = 0
    await execute(createAgentProfileSetTool(ctx), { avatarUrl: 'https://example.com/a.png' })
    expect(calls).toEqual([
      { name: 'setAgentProfile', args: ['workspace-1', { avatarUrl: 'https://example.com/a.png' }] },
    ])
  })
})
