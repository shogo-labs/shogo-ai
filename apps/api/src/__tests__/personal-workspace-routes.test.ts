// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const profile = {
  id: 'profile-1',
  workspaceId: 'workspace-1',
  name: 'Shogo',
  avatarUrl: null,
  tagline: 'Your personal AI companion',
  personality: null,
  statusText: null,
  statusUpdatedAt: null,
}

mock.module('../services/workspace.service', () => ({
  hasWorkspaceAccess: async (workspaceId: string, userId: string) =>
    workspaceId === 'workspace-1' && userId === 'user-1',
}))

mock.module('../services/personal-workspace.service', () => ({
  createGoal: async () => ({ id: 'goal-1', title: 'Habit tracker', status: 'active' }),
  createGoalEvent: async () => ({ id: 'event-1', kind: 'progress', message: 'Started' }),
  getOrCreateAgentProfile: async () => profile,
  updateAgentProfile: async (_workspaceId: string, changes: Record<string, unknown>) => ({
    ...profile,
    ...changes,
  }),
  updateGoal: async () => ({ id: 'goal-1', title: 'Habit tracker', status: 'active' }),
  isGoalStatus: (value: unknown) => ['active', 'paused', 'done'].includes(String(value)),
  isGoalEventKind: (value: unknown) => ['progress', 'blocker', 'approval', 'note', 'deliverable'].includes(String(value)),
  getGoal: async (_workspaceId: string, goalId: string) =>
    goalId === 'goal-1' ? { id: 'goal-1', title: 'Habit tracker', events: [], agentTasks: [] } : null,
  listGoals: async () => [{ id: 'goal-1', title: 'Habit tracker', status: 'active' }],
  listGoalEvents: async () => [{ id: 'event-1', kind: 'progress', message: 'Started' }],
  listWorkspaceActivity: async () => [{ type: 'goal_event', id: 'event-1' }],
}))

const { personalWorkspaceRoutes } = await import('../routes/personal-workspace')

function appFor(userId: string | null) {
  const app = new Hono()
  app.route('/api', personalWorkspaceRoutes({ resolveUserId: async () => userId }))
  return app
}

describe('personal workspace routes', () => {
  test('requires authentication and workspace membership', async () => {
    expect((await appFor(null).request('/api/workspaces/workspace-1/agent-profile')).status).toBe(401)
    expect((await appFor('user-2').request('/api/workspaces/workspace-1/agent-profile')).status).toBe(403)
  })

  test('returns and updates the agent profile', async () => {
    const getResponse = await appFor('user-1').request('/api/workspaces/workspace-1/agent-profile')
    expect(getResponse.status).toBe(200)
    expect(await getResponse.json()).toMatchObject({ profile: { name: 'Shogo' } })

    const patchResponse = await appFor('user-1').request('/api/workspaces/workspace-1/agent-profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statusText: 'Planning your next step' }),
    })
    expect(patchResponse.status).toBe(200)
    expect(await patchResponse.json()).toMatchObject({
      profile: { statusText: 'Planning your next step' },
    })
  })

  test('lists goals, goal details, and activity', async () => {
    const goals = await appFor('user-1').request('/api/workspaces/workspace-1/goals?status=active')
    expect(goals.status).toBe(200)
    expect(await goals.json()).toMatchObject({ goals: [{ id: 'goal-1' }] })

    const goal = await appFor('user-1').request('/api/workspaces/workspace-1/goals/goal-1')
    expect(goal.status).toBe(200)
    expect(await goal.json()).toMatchObject({ goal: { title: 'Habit tracker' } })

    const activity = await appFor('user-1').request('/api/workspaces/workspace-1/activity')
    expect(activity.status).toBe(200)
    expect(await activity.json()).toMatchObject({ activity: [{ id: 'event-1' }] })
  })
})
