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

const memberRoles: Record<string, string> = {
  'user-1': 'member',
  'user-admin': 'admin',
  'user-other': 'member',
  'user-viewer': 'viewer',
}

mock.module('../services/workspace.service', () => ({
  hasWorkspaceAccess: async (workspaceId: string, userId: string, requiredRoles?: string[]) => {
    const role = workspaceId === 'workspace-1' ? memberRoles[userId] : undefined
    return !!role && (!requiredRoles || requiredRoles.includes(role))
  },
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

const schedule = {
  id: 'schedule-1',
  workspaceId: 'workspace-1',
  goalId: 'goal-1',
  userId: 'user-1',
  name: 'Morning digest',
  prompt: 'Review the inbox.',
  cronExpression: '0 9 * * 1-5',
  timezone: 'America/Los_Angeles',
  enabled: true,
  nextRunAt: '2026-09-22T16:00:00.000Z',
}

mock.module('../services/agent-schedule.service', () => ({
  AgentScheduleError: class AgentScheduleError extends Error {
    code = 'invalid_cron'
    status = 400
  },
  listSchedules: async () => [schedule],
  getSchedule: async (_workspaceId: string, scheduleId: string) =>
    scheduleId === 'schedule-1' ? schedule : null,
  createSchedule: async (input: any) => ({ ...schedule, ...input, id: 'schedule-1' }),
  updateSchedule: async (_workspaceId: string, _scheduleId: string, changes: any) => ({ ...schedule, ...changes }),
  deleteSchedule: async () => true,
}))

mock.module('../services/chat-turn-state.service', () => ({
  listActiveChatTurns: async () => [{
    chatSessionId: 'chat-1',
    turnId: 'turn-1',
    sessionName: 'Planning',
    isPrimary: false,
    projectId: 'project-1',
    projectName: 'Website',
    projectHidden: false,
    startedAt: new Date('2026-09-23T05:00:00.000Z'),
  }],
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

  test('returns active chats scoped to an authorized workspace', async () => {
    const response = await appFor('user-1').request('/api/workspaces/workspace-1/active-chats')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      chats: [{ chatSessionId: 'chat-1', projectName: 'Website' }],
    })
    expect((await appFor('user-2').request('/api/workspaces/workspace-1/active-chats')).status).toBe(403)
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

  // Regression test for the 2026-09-21 incident: workspace-agent-cloud-storage.ts's
  // saveAgentAvatar used to swallow any storage failure into a base64 data: URI
  // fallback that got persisted forever and resent as chat context on every
  // turn. It now propagates the error, so this route (with no local try/catch
  // of its own) must surface a failure rather than a 200 with a giant inline
  // image.
  test('surfaces a storage failure instead of silently succeeding', async () => {
    const app = new Hono()
    app.route(
      '/api',
      workspaceAgentRoutes({
        authorize: sessionAuthorize(async () => 'user-1'),
        saveAgentAvatar: async () => {
          throw new Error('S3_ARTIFACT_BUCKET environment variable is required for S3 storage')
        },
      }),
    )
    const res = await app.request('/api/workspaces/workspace-1/agent-avatar', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3, 4]),
    })
    expect(res.status).not.toBe(200)
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

  test('lets an authenticated workspace agent create and manage goal schedules', async () => {
    const create = await appFor('user-1').request('/api/workspaces/workspace-1/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Morning digest',
        prompt: 'Review the inbox.',
        cronExpression: '0 9 * * 1-5',
        timezone: 'America/Los_Angeles',
        goalId: 'goal-1',
      }),
    })
    expect(create.status).toBe(201)
    expect(await create.json()).toMatchObject({ schedule: { goalId: 'goal-1' } })

    const list = await appFor('user-1').request('/api/workspaces/workspace-1/schedules?goalId=goal-1')
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({ schedules: [{ id: 'schedule-1' }] })

    const update = await appFor('user-1').request('/api/workspaces/workspace-1/schedules/schedule-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(update.status).toBe(200)

    const remove = await appFor('user-1').request('/api/workspaces/workspace-1/schedules/schedule-1', {
      method: 'DELETE',
    })
    expect(remove.status).toBe(200)
  })

  test('rejects non-members on every schedule route', async () => {
    const app = appFor('user-2')
    const json = { 'content-type': 'application/json' }
    const responses = await Promise.all([
      app.request('/api/workspaces/workspace-1/schedules'),
      app.request('/api/workspaces/workspace-1/schedules', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'x', prompt: 'y', cronExpression: '0 9 * * *' }),
      }),
      app.request('/api/workspaces/workspace-1/schedules/schedule-1', {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ enabled: false }),
      }),
      app.request('/api/workspaces/workspace-1/schedules/schedule-1', { method: 'DELETE' }),
    ])
    expect(responses.map((res) => res.status)).toEqual([403, 403, 403, 403])
  })

  test('viewers cannot create schedules', async () => {
    const res = await appFor('user-viewer').request('/api/workspaces/workspace-1/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', prompt: 'y', cronExpression: '0 9 * * *' }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } })
  })

  test('only the creator or a workspace admin can update or delete a schedule', async () => {
    const patch = (userId: string) =>
      appFor(userId).request('/api/workspaces/workspace-1/schedules/schedule-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    const remove = (userId: string) =>
      appFor(userId).request('/api/workspaces/workspace-1/schedules/schedule-1', { method: 'DELETE' })

    expect((await patch('user-other')).status).toBe(403)
    expect((await remove('user-other')).status).toBe(403)
    expect((await patch('user-viewer')).status).toBe(403)
    expect((await patch('user-1')).status).toBe(200)
    expect((await remove('user-1')).status).toBe(200)
    expect((await patch('user-admin')).status).toBe(200)
    expect((await remove('user-admin')).status).toBe(200)
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

  describe('internal schedule mutations', () => {
    const app = appWithAuthorize(async (c) => ({ workspaceId: c.req.param('workspaceId') }))
    const send = (method: string, path: string, body?: Record<string, unknown>) =>
      app.request(`/api/internal/workspaces/workspace-1/schedules${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })

    test('create requires a member userId', async () => {
      const draft = { name: 'x', prompt: 'y', cronExpression: '0 9 * * *' }
      expect((await send('POST', '', { ...draft, userId: 'user-2' })).status).toBe(403)
      expect((await send('POST', '', { ...draft, userId: 'user-viewer' })).status).toBe(403)
      expect((await send('POST', '', { ...draft, userId: 'user-1' })).status).toBe(201)
    })

    test('update and delete reject requests without an acting user', async () => {
      expect((await send('PATCH', '/schedule-1', { enabled: false })).status).toBe(400)
      expect((await send('DELETE', '/schedule-1')).status).toBe(400)
    })

    test('update and delete enforce creator-or-admin for the acting user', async () => {
      expect((await send('PATCH', '/schedule-1', { enabled: false, userId: 'user-2' })).status).toBe(403)
      expect((await send('PATCH', '/schedule-1', { enabled: false, userId: 'user-other' })).status).toBe(403)
      expect((await send('DELETE', '/schedule-1', { userId: 'user-other' })).status).toBe(403)
      expect((await send('PATCH', '/schedule-1', { enabled: false, userId: 'user-1' })).status).toBe(200)
      expect((await send('DELETE', '/schedule-1', { userId: 'user-admin' })).status).toBe(200)
    })
  })
})
