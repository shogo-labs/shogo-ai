// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Supplemental coverage for `src/routes/cost-analytics.ts` beyond what
 * `cost-analytics-route.test.ts` exercises. Pins:
 *
 *   - POST   /agent-eval-sets      — admin gate + extensive body validation
 *                                   (missing agentType, missing name, examples
 *                                   not an array / empty, projectId not in
 *                                   workspace, id type-coercion) + upsert
 *                                   happy path
 *   - DELETE /agent-eval-sets/:id  — admin gate + happy path
 *   - GET    /subagent-overrides    — member gate + list
 *   - POST   /subagent-overrides    — admin gate + body validation (agentType
 *                                    + model required, main-chat ban) + happy
 *   - DELETE /subagent-overrides/:agentType — admin gate + projectId query
 *                                              forwarding + happy
 *   - cost_analytics_failed 500 path on each of those endpoints when the
 *     service throws
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

let currentUserId: string | null = 'user_1'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { userId: currentUserId }); await next() },
  requireAuth: async (_c: any, next: any) => next(),
}))

type Member = { userId: string; workspaceId: string; role: string }
let members: Member[] = []
let projects: Map<string, { workspaceId: string }> = new Map()

mock.module('../lib/prisma', () => ({
  prisma: {
    member: {
      findFirst: async (args: any) => {
        const w = args.where
        return members.find(
          (m) => m.userId === w.userId && m.workspaceId === w.workspaceId
            && (!w.role?.in || w.role.in.includes(m.role)),
        ) ?? null
      },
    },
    project: {
      findFirst: async (args: any) => {
        const w = args.where
        const p = projects.get(w.id)
        if (!p) return null
        if (w.workspaceId && p.workspaceId !== w.workspaceId) return null
        return { id: w.id, workspaceId: p.workspaceId }
      },
    },
  },
}))

const upsertAgentEvalSet = mock(async (..._: any[]): Promise<any> => ({ id: 'eval_new' }))
const deleteAgentEvalSet = mock(async (..._: any[]): Promise<any> => true)
const listSubagentOverrides = mock(async (..._: any[]): Promise<any> => [{ agentType: 'foo', model: 'sonnet' }])
const upsertSubagentOverride = mock(async (..._: any[]): Promise<any> => ({ agentType: 'foo', model: 'sonnet' }))
const deleteSubagentOverride = mock(async (..._: any[]): Promise<any> => undefined)

mock.module('../services/cost-analytics.service', () => ({
  // Required by the existing test surface
  getAgentCostBreakdown: async () => ({ breakdown: [] }),
  getCostRecommendations: async () => [],
  getCostTrends: async () => ({ trends: [] }),
  getBudgetAlerts: async () => [],
  createBudgetAlert: async () => ({}),
  updateBudgetAlert: async () => ({}),
  deleteBudgetAlert: async () => undefined,
  getBudgetAlertUsage: async () => [],
  deriveActiveThrottleModel: () => null,
  getExperiments: async () => [],
  createExperiment: async () => ({}),
  getExperiment: async () => null,
  stopExperiment: async () => ({}),
  createShadowExperiment: async () => ({}),
  summarizeExperiment: async () => null,
  getOptimizerInActionReport: async () => ({}),
  listAgentEvalSets: async () => [],
  isCostPeriod: (v: string) => ['7d', '30d', '90d', '1y'].includes(v),
  // The endpoints we're focused on:
  upsertAgentEvalSet,
  deleteAgentEvalSet,
  listSubagentOverrides,
  upsertSubagentOverride,
  deleteSubagentOverride,
}))

const { costAnalyticsRoutes } = await import('../routes/cost-analytics')

const WS = 'ws_1'
const PATH = (suffix: string) => `/workspaces/${WS}/cost-analytics/${suffix}`

async function call(method: string, path: string, body?: any) {
  const init: any = { method }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await costAnalyticsRoutes().fetch(new Request(`http://test${path}`, init))
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

beforeEach(() => {
  members = []
  projects = new Map()
  currentUserId = 'user_1'
  upsertAgentEvalSet.mockClear()
  upsertAgentEvalSet.mockImplementation(async () => ({ id: 'eval_new' }))
  deleteAgentEvalSet.mockClear()
  deleteAgentEvalSet.mockImplementation(async () => true)
  listSubagentOverrides.mockClear()
  listSubagentOverrides.mockImplementation(async () => [{ agentType: 'foo', model: 'sonnet' }])
  upsertSubagentOverride.mockClear()
  upsertSubagentOverride.mockImplementation(async () => ({ agentType: 'foo', model: 'sonnet' }))
  deleteSubagentOverride.mockClear()
  deleteSubagentOverride.mockImplementation(async () => undefined)
})

const seedMember = (role: 'owner' | 'admin' | 'editor' | 'viewer' = 'admin') => {
  members.push({ userId: 'user_1', workspaceId: WS, role })
}

// ─── POST /agent-eval-sets ─────────────────────────────────────────────

describe('POST /agent-eval-sets', () => {
  test('403 admin-only when caller is a viewer', async () => {
    seedMember('viewer')
    const res = await call('POST', PATH('agent-eval-sets'), {
      agentType: 'main-chat', name: 'N', examples: [{ a: 1 }],
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
  })

  test('400 bad_request when body is invalid JSON', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('agent-eval-sets'), 'not json')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  test('400 when agentType is missing', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('agent-eval-sets'), { name: 'N', examples: [{}] })
    expect(res.status).toBe(400)
  })

  test('400 when name is missing', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('agent-eval-sets'), { agentType: 'A', examples: [{}] })
    expect(res.status).toBe(400)
  })

  test('400 when examples is not an array', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('agent-eval-sets'), { agentType: 'A', name: 'N', examples: 'not-array' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('examples must be a non-empty array')
  })

  test('400 when examples is an empty array', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('agent-eval-sets'), { agentType: 'A', name: 'N', examples: [] })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('examples must be a non-empty array')
  })

  test('400 when projectId does not belong to the workspace', async () => {
    seedMember('admin')
    projects.set('p_other', { workspaceId: 'ws_other' })
    const res = await call('POST', PATH('agent-eval-sets'), {
      agentType: 'A', name: 'N', examples: [{}], projectId: 'p_other',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('projectId must belong to this workspace')
  })

  test('201 created when valid + no id supplied', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('agent-eval-sets'), {
      agentType: 'A', name: 'N', examples: [{ x: 1 }],
    })
    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(upsertAgentEvalSet).toHaveBeenCalledTimes(1)
  })

  test('200 updated when id supplied', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('agent-eval-sets'), {
      id: 'existing_id', agentType: 'A', name: 'N', examples: [{ x: 1 }],
    })
    expect(res.status).toBe(200)
  })

  test('404 not_found when service returns null/undefined', async () => {
    seedMember('admin')
    upsertAgentEvalSet.mockImplementation(async () => null)
    const res = await call('POST', PATH('agent-eval-sets'), {
      agentType: 'A', name: 'N', examples: [{ x: 1 }],
    })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  test('500 cost_analytics_failed when upsert throws', async () => {
    seedMember('admin')
    upsertAgentEvalSet.mockImplementation(async () => { throw new Error('db down') })
    const res = await call('POST', PATH('agent-eval-sets'), {
      agentType: 'A', name: 'N', examples: [{ x: 1 }],
    })
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('cost_analytics_failed')
    expect(res.body.error.message).toBe('db down')
  })
})

// ─── DELETE /agent-eval-sets/:id ───────────────────────────────────────

describe('DELETE /agent-eval-sets/:id', () => {
  test('403 admin-only', async () => {
    seedMember('viewer')
    const res = await call('DELETE', PATH('agent-eval-sets/eval_1'))
    expect(res.status).toBe(403)
  })

  test('200 ok when admin deletes (service returns truthy)', async () => {
    seedMember('admin')
    const res = await call('DELETE', PATH('agent-eval-sets/eval_1'))
    expect(res.status).toBe(200)
    expect(deleteAgentEvalSet).toHaveBeenCalled()
  })

  test('404 not_found when deleteAgentEvalSet returns falsy', async () => {
    seedMember('admin')
    deleteAgentEvalSet.mockImplementation(async () => undefined)
    const res = await call('DELETE', PATH('agent-eval-sets/missing_id'))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  test('500 when service throws', async () => {
    seedMember('admin')
    deleteAgentEvalSet.mockImplementation(async () => { throw new Error('boom') })
    const res = await call('DELETE', PATH('agent-eval-sets/eval_1'))
    expect(res.status).toBe(500)
  })
})

// ─── GET /subagent-overrides ───────────────────────────────────────────

describe('GET /subagent-overrides', () => {
  test('403 when not a member', async () => {
    const res = await call('GET', PATH('subagent-overrides'))
    expect(res.status).toBe(403)
  })

  test('200 returns service list to members', async () => {
    seedMember('editor')
    const res = await call('GET', PATH('subagent-overrides'))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data[0].agentType).toBe('foo')
  })

  test('500 when listSubagentOverrides throws', async () => {
    seedMember('editor')
    listSubagentOverrides.mockImplementation(async () => { throw new Error('list-fail') })
    const res = await call('GET', PATH('subagent-overrides'))
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('cost_analytics_failed')
  })
})

// ─── POST /subagent-overrides ──────────────────────────────────────────

describe('POST /subagent-overrides', () => {
  test('403 admin-only', async () => {
    seedMember('viewer')
    const res = await call('POST', PATH('subagent-overrides'), { agentType: 'x', model: 'sonnet' })
    expect(res.status).toBe(403)
  })

  test('400 when agentType is missing', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('subagent-overrides'), { model: 'sonnet' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('agentType and model are required')
  })

  test('400 when model is missing', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('subagent-overrides'), { agentType: 'x' })
    expect(res.status).toBe(400)
  })

  test('400 when body is invalid JSON', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('subagent-overrides'), 'not json')
    expect(res.status).toBe(400)
  })

  test('400 when agentType is "main-chat" (banned as sub-agent override)', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('subagent-overrides'), { agentType: 'main-chat', model: 'sonnet' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('main-chat recommendations cannot be applied as sub-agent overrides')
  })

  test('200 happy path forwards provider + projectId + updatedBy', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('subagent-overrides'), {
      agentType: 'reviewer', model: 'haiku', provider: 'anthropic', projectId: 'p1',
    })
    expect(res.status).toBe(200)
    expect(upsertSubagentOverride).toHaveBeenCalledTimes(1)
    const args = upsertSubagentOverride.mock.calls[0]!
    expect(args[0]).toBe(WS)
    expect(args[1]).toMatchObject({
      agentType: 'reviewer',
      model: 'haiku',
      provider: 'anthropic',
      projectId: 'p1',
      updatedBy: 'user_1',
    })
  })

  test('500 when upsert throws', async () => {
    seedMember('admin')
    upsertSubagentOverride.mockImplementation(async () => { throw new Error('upsert boom') })
    const res = await call('POST', PATH('subagent-overrides'), { agentType: 'x', model: 'y' })
    expect(res.status).toBe(500)
  })
})

// ─── DELETE /subagent-overrides/:agentType ─────────────────────────────

describe('DELETE /subagent-overrides/:agentType', () => {
  test('403 admin-only', async () => {
    seedMember('viewer')
    const res = await call('DELETE', PATH('subagent-overrides/foo'))
    expect(res.status).toBe(403)
  })

  test('200 happy path forwards projectId from query string', async () => {
    seedMember('admin')
    const res = await call('DELETE', PATH('subagent-overrides/foo?projectId=p_a'))
    expect(res.status).toBe(200)
    expect(deleteSubagentOverride).toHaveBeenCalled()
    const args = deleteSubagentOverride.mock.calls[0]!
    expect(args[1]).toBe('foo')
    expect(args[2]).toBe('p_a')
  })

  test('200 happy path with null projectId when query absent', async () => {
    seedMember('admin')
    const res = await call('DELETE', PATH('subagent-overrides/foo'))
    expect(res.status).toBe(200)
    const args = deleteSubagentOverride.mock.calls[0]!
    expect(args[2]).toBeNull()
  })

  test('500 when service throws', async () => {
    seedMember('admin')
    deleteSubagentOverride.mockImplementation(async () => { throw new Error('del boom') })
    const res = await call('DELETE', PATH('subagent-overrides/foo'))
    expect(res.status).toBe(500)
  })
})
