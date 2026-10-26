// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Authorization, member scoping, plan gating and period handling for
// GET /workspaces/:id/analytics/heartbeats in src/routes/scoped-analytics.ts.
// The aggregation itself is covered by analytics-heartbeats.test.ts.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

let currentUserId: string | null = 'admin_1'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { userId: currentUserId }); await next() },
  requireAuth: async (_c: any, next: any) => next(),
}))

/** What `getAccess` reports for the workspace: membership + the admin permission. */
let permissions = new Set<string>()
const MEMBER_PROJECT_WHERE = { OR: [{ workspaceId: 'ws_1', visibility: 'workspace' }] }
let passedProjectWhere: unknown

mock.module('../lib/authz', () => ({
  getAccess: async () => ({ permissions, exists: true }),
  principalOf: () => ({ userId: currentUserId, via: 'session' }),
  can: async (_c: any, permission: string, scope: any) => {
    canCalls.push({ permission, projectId: scope?.projectId })
    return canResult
  },
  accessibleProjectsWhere: async () => {
    passedProjectWhere = MEMBER_PROJECT_WHERE
    return MEMBER_PROJECT_WHERE
  },
  authorize: async () => ({ ok: false }),
}))

const canCalls: Array<{ permission: string; projectId?: string }> = []
let canResult = true
let isBusiness = true
mock.module('../services/billing.service', () => ({ isBusinessOrHigherPlan: async () => isBusiness }))

const row = (over: Record<string, any> = {}) => ({
  projectId: 'p_1',
  projectName: 'Heartbeat Heavy',
  owner: null,
  enabled: true,
  intervalSeconds: 1800,
  quietHours: null,
  lastHeartbeatAt: null,
  nextHeartbeatAt: null,
  configuredModel: 'model-uuid',
  configuredModelLabel: 'Hoshi',
  modelsUsed: [],
  ticks: 3,
  billedUsd: 5,
  rawUsd: 5,
  totalTokens: 1500,
  avgUsdPerTick: 5 / 3,
  canEdit: false,
  ...over,
})

const payload = (over: Record<string, any> = {}) => ({
  period: '24h',
  window: { from: '2026-10-23T12:00:00.000Z', to: '2026-10-24T12:00:00.000Z' },
  totals: {
    agentsEnabled: 2,
    agentsWithSpend: 1,
    ticks: 3,
    billedUsd: 5,
    rawUsd: 5,
    totalTokens: 1500,
    workspaceBilledUsd: 20,
  },
  daily: [{ date: '2026-10-24', heartbeatUsd: 5, otherUsd: 15 }],
  agents: [row(), row({ projectId: 'p_2', projectName: 'Other', billedUsd: 0, ticks: 0 })],
  ...over,
})

const getWorkspaceHeartbeats = mock(async (..._args: any[]): Promise<any> => payload())

// Keep the real module's other exports: `engagement-analytics.service` (pulled in
// by scoped-analytics) imports `periodToWindow` from it, and a bare `({})` mock
// breaks that link.
const realAnalytics = await import('../services/analytics.service')

mock.module('../services/analytics.service', () => ({
  ...realAnalytics,
  getWorkspaceHeartbeats,
}))

const { scopedAnalyticsRoutes } = await import('../routes/scoped-analytics')

const WS = 'ws_1'

async function get(path: string) {
  const res = await scopedAnalyticsRoutes().fetch(new Request(`http://test${path}`))
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any }
}

beforeEach(() => {
  currentUserId = 'admin_1'
  permissions = new Set(['workspace:read', 'workspace.analytics:read'])
  isBusiness = true
  canResult = true
  canCalls.length = 0
  passedProjectWhere = undefined
  getWorkspaceHeartbeats.mockClear()
  getWorkspaceHeartbeats.mockImplementation(async () => payload())
  delete process.env.SHOGO_LOCAL_MODE
})

const path = (qs = '') => `/workspaces/${WS}/analytics/heartbeats${qs}`

describe('GET /workspaces/:id/analytics/heartbeats', () => {
  test('an admin gets every heartbeat in the workspace, with the default 24h window', async () => {
    const { status, body } = await get(path())

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.period).toBe('24h')
    expect(body.data.agents).toHaveLength(2)
    expect(body.data.totals).toMatchObject({ ticks: 3, workspaceBilledUsd: 20 })

    const [workspaceId, options] = getWorkspaceHeartbeats.mock.calls[0]
    expect(workspaceId).toBe(WS)
    expect(options.period).toBe('24h')
    // An admin is not narrowed to their own projects.
    expect(options.projectWhere).toBeUndefined()
    // ...and may switch any of them off without an extra per-project check.
    expect(canCalls).toHaveLength(0)
    expect(body.data.agents.every((a: any) => a.canEdit === true)).toBe(true)
  })

  test('carries the requested period through, and falls back to 24h on nonsense', async () => {
    await get(path('?period=30d'))
    expect(getWorkspaceHeartbeats.mock.calls[0][1].period).toBe('30d')

    await get(path('?period=forever'))
    expect(getWorkspaceHeartbeats.mock.calls[1][1].period).toBe('24h')
  })

  test('a member is narrowed to their own projects and only gets rows they may edit', async () => {
    currentUserId = 'user_1'
    permissions = new Set(['workspace:read'])
    canResult = false

    const { status, body } = await get(path())

    expect(status).toBe(200)
    // Same rule as `member-usage`: the report is scoped, not workspace-wide.
    expect(getWorkspaceHeartbeats.mock.calls[0][1].projectWhere).toBe(MEMBER_PROJECT_WHERE)
    expect(passedProjectWhere).toBe(MEMBER_PROJECT_WHERE)
    // A viewer still sees the rows, but no "Turn off" action.
    expect(body.data.agents.map((a: any) => a.canEdit)).toEqual([false, false])
    expect(canCalls.map((call) => call.permission)).toEqual(['project:update', 'project:update'])
    expect(canCalls.map((call) => call.projectId)).toEqual(['p_1', 'p_2'])
  })

  test('a member who can edit their project gets the action on that row only', async () => {
    currentUserId = 'user_1'
    permissions = new Set(['workspace:read'])
    canResult = true

    const { body } = await get(path())
    expect(body.data.agents.map((a: any) => a.canEdit)).toEqual([true, true])
  })

  test('a non-member is refused and the report is never built', async () => {
    currentUserId = 'stranger'
    permissions = new Set()

    const { status, body } = await get(path())
    expect(status).toBe(403)
    expect(body.error.code).toBe('forbidden')
    expect(getWorkspaceHeartbeats).not.toHaveBeenCalled()
  })

  test('another workspace the caller is not in is refused', async () => {
    permissions = new Set()
    const { status } = await get(`/workspaces/ws_2/analytics/heartbeats`)
    expect(status).toBe(403)
    expect(getWorkspaceHeartbeats).not.toHaveBeenCalled()
  })

  test('is gated to the Business plan', async () => {
    isBusiness = false
    const { status, body } = await get(path())
    expect(status).toBe(403)
    expect(body.error.code).toBe('plan_required')
    expect(getWorkspaceHeartbeats).not.toHaveBeenCalled()
  })

  test('local mode is never gated, whatever the plan says', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    isBusiness = false
    expect((await get(path())).status).toBe(200)
  })

  test('service failures surface as analytics_failed with the real message', async () => {
    getWorkspaceHeartbeats.mockImplementationOnce(async () => { throw new Error('boom') })
    const { status, body } = await get(path())
    expect(status).toBe(500)
    expect(body.error).toEqual({ code: 'analytics_failed', message: 'boom' })
  })
})
