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

mock.module('../services/workspace-agent.service', () => ({
  createGoal: async () => ({ id: 'goal-1', title: 'Habit tracker', status: 'active' }),
  createGoalEvent: async () => ({ id: 'event-1', kind: 'progress', message: 'Started' }),
  getOrCreateAgentProfile: async () => profile,
  saveAgentAvatar: async (workspaceId: string, buffer: Buffer) =>
    buffer.byteLength > 0 ? `https://artifacts.example.com/avatars/${workspaceId}.png` : null,
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
  resolveGoalEventApproval: async (
    _workspaceId: string,
    goalId: string,
    eventId: string,
    decision: 'approved' | 'declined',
  ) =>
    goalId === 'goal-1' && eventId === 'event-approval-1'
      ? { id: eventId, kind: 'approval', metadata: { decision, resolvedAt: '2026-01-01T00:00:00.000Z' } }
      : null,
}))

const { workspaceAgentRoutes, sessionAuthorize } = await import('../routes/workspace-agent')

function appFor(userId: string | null) {
  const app = new Hono()
  app.route('/api', workspaceAgentRoutes({ authorize: sessionAuthorize(async () => userId) }))
  return app
}

describe('workspace agent routes (session-authorized mount)', () => {
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

  test('uploads an avatar image and sets it on the profile', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const res = await appFor('user-1').request('/api/workspaces/workspace-1/agent-avatar', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      profile: { avatarUrl: 'https://artifacts.example.com/avatars/workspace-1.png' },
    })
  })

  test('rejects an empty avatar upload body', async () => {
    const res = await appFor('user-1').request('/api/workspaces/workspace-1/agent-avatar', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([]),
    })
    expect(res.status).toBe(400)
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

  test('creates goals and goal events', async () => {
    const createGoal = await appFor('user-1').request('/api/workspaces/workspace-1/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Habit tracker' }),
    })
    expect(createGoal.status).toBe(201)

    const createEvent = await appFor('user-1').request('/api/workspaces/workspace-1/goals/goal-1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'progress', message: 'Started' }),
    })
    expect(createEvent.status).toBe(201)
  })

  test('resolves a pending approval event', async () => {
    const resolved = await appFor('user-1').request(
      '/api/workspaces/workspace-1/goals/goal-1/events/event-approval-1/resolve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      },
    )
    expect(resolved.status).toBe(200)
    expect(await resolved.json()).toMatchObject({ event: { metadata: { decision: 'approved' } } })
  })

  test('rejects an invalid decision value', async () => {
    const res = await appFor('user-1').request(
      '/api/workspaces/workspace-1/goals/goal-1/events/event-approval-1/resolve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'maybe' }),
      },
    )
    expect(res.status).toBe(400)
  })

  test('404s resolving an event that does not exist', async () => {
    const res = await appFor('user-1').request(
      '/api/workspaces/workspace-1/goals/goal-1/events/does-not-exist/resolve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      },
    )
    expect(res.status).toBe(404)
  })
})

describe('workspace agent routes (authorize-strategy agnostic)', () => {
  // internal.ts mounts the same router with an `authorizeWorkspaceScope`
  // strategy instead of `sessionAuthorize`. Rather than re-exercise the
  // whole internal.ts app (heavy pod-token/k8s mocking), verify the router
  // itself is strategy-agnostic: any `authorize` fn that returns a context
  // or a Response drives the same handler contract.
  function appWithAuthorize(authorize: (c: any) => Promise<{ workspaceId: string } | Response>) {
    const app = new Hono()
    app.route('/api/internal', workspaceAgentRoutes({ authorize }))
    return app
  }

  test('a Response from authorize short-circuits before touching the service layer', async () => {
    const app = appWithAuthorize(async (c) => c.json({ error: 'Unauthorized' }, 401))
    const res = await app.request('/api/internal/workspaces/workspace-1/agent-profile')
    expect(res.status).toBe(401)
  })

  test('a resolved context proceeds to the shared handler', async () => {
    const app = appWithAuthorize(async (c) => ({ workspaceId: c.req.param('workspaceId') }))
    const res = await app.request('/api/internal/workspaces/workspace-1/agent-profile')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ profile: { name: 'Shogo' } })
  })
})
