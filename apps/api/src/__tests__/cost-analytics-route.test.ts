// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/cost-analytics.ts` — workspace-scoped cost analytics.
 *
 * Covers a representative subset across all sections of the route file:
 *   - parsePeriod helper (invalid period → 400, default 30d, all allowlist values)
 *   - workspace access guards (403 not-member / 403 not-admin)
 *   - agent-breakdown, recommendations, trends (with projectId)
 *   - budget-alerts GET/POST/PATCH/DELETE (admin checks, body validation)
 *   - budget-status (derives throttleModel from breached entries)
 *   - experiments GET list / POST create (input validation, bad_request mapping)
 *   - experiments GET-by-id (404)
 *   - stop experiment
 *   - shadow experiment (admin + body validation)
 *   - summarize experiment
 *   - optimizer-in-action
 *   - agent-eval-sets list (query param parsing)
 *   - cost_analytics_failed catch branch
 *
 * `../middleware/auth`, `../lib/prisma`, and the cost-analytics service are
 * all stubbed.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Middleware mock ──────────────────────────────────────────────────

let currentUserId: string | null = 'user_1'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { userId: currentUserId })
    await next()
  },
  requireAuth: async (_c: any, next: any) => next(),
}))

// ─── Prisma mock ──────────────────────────────────────────────────────

type Member = { userId: string; workspaceId: string; role: string }
let members: Member[] = []

mock.module('../lib/prisma', () => ({
  prisma: {
    member: {
      findFirst: async (args: any) => {
        const w = args.where
        return (
          members.find(
            (m) =>
              m.userId === w.userId &&
              m.workspaceId === w.workspaceId &&
              (!w.role?.in || w.role.in.includes(m.role)),
          ) ?? null
        )
      },
    },
  },
}))

// ─── Cost-analytics service mock ──────────────────────────────────────

const svcSpies = {
  getAgentCostBreakdown: mock(async (..._: any[]): Promise<any> => ({ breakdown: [] })),
  getCostRecommendations: mock(async (..._: any[]): Promise<any> => []),
  getCostTrends: mock(async (..._: any[]): Promise<any> => ({ trends: [] })),
  getBudgetAlerts: mock(async (..._: any[]): Promise<any> => []),
  createBudgetAlert: mock(async (..._: any[]): Promise<any> => ({ id: 'ba_new' })),
  updateBudgetAlert: mock(async (..._: any[]): Promise<any> => ({ id: 'ba_1', updated: true })),
  deleteBudgetAlert: mock(async (..._: any[]): Promise<any> => undefined),
  getBudgetAlertUsage: mock(async (..._: any[]): Promise<any> => []),
  deriveActiveThrottleModel: mock((_: any): string | null => null),
  getExperiments: mock(async (..._: any[]): Promise<any> => []),
  createExperiment: mock(async (..._: any[]): Promise<any> => ({ id: 'exp_new' })),
  getExperiment: mock(async (..._: any[]): Promise<any> => null),
  stopExperiment: mock(async (..._: any[]): Promise<any> => ({ id: 'exp_1', status: 'stopped' })),
  createShadowExperiment: mock(async (..._: any[]): Promise<any> => ({ id: 'exp_shadow' })),
  summarizeExperiment: mock(async (..._: any[]): Promise<any> => null),
  getOptimizerInActionReport: mock(async (..._: any[]): Promise<any> => ({ savings: 0 })),
  listAgentEvalSets: mock(async (..._: any[]): Promise<any> => []),
  isCostPeriod: (v: string) => ['7d', '30d', '90d', '1y'].includes(v),
}

mock.module('../services/cost-analytics.service', () => svcSpies)

const { costAnalyticsRoutes } = await import('../routes/cost-analytics')

// ─── helpers ──────────────────────────────────────────────────────────

function makeApp() {
  return costAnalyticsRoutes()
}

async function call(
  method: string,
  path: string,
  body?: any,
): Promise<{ status: number; body: any }> {
  const init: any = { method }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await makeApp().fetch(new Request(`http://test${path}`, init))
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

const WS = 'ws_1'
const PATH = (suffix: string) => `/workspaces/${WS}/cost-analytics/${suffix}`

beforeEach(() => {
  members = []
  currentUserId = 'user_1'
  for (const k of Object.keys(svcSpies)) {
    const fn = (svcSpies as any)[k]
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as any).mockClear()
  }
})

function seedMember(role: 'owner' | 'admin' | 'editor' | 'viewer' = 'editor') {
  members.push({ userId: 'user_1', workspaceId: WS, role })
}

// ──────────────────────────────────────────────────────────────────────
// access guards
// ──────────────────────────────────────────────────────────────────────

describe('access guards', () => {
  test('non-member → 403 forbidden on member-only endpoint', async () => {
    const res = await call('GET', PATH('agent-breakdown'))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    expect(res.body.error.message).toContain('Not a member')
  })

  test('member but not admin → 403 forbidden on admin-only endpoint', async () => {
    seedMember('viewer')
    const res = await call('POST', PATH('budget-alerts'), {
      name: 'N',
      creditLimit: 100,
    })
    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('Admin access required')
  })

  test('owner can hit admin endpoint', async () => {
    seedMember('owner')
    const res = await call('POST', PATH('budget-alerts'), {
      name: 'N',
      creditLimit: 100,
    })
    expect(res.status).toBe(201)
  })

  test('admin can hit admin endpoint', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('budget-alerts'), {
      name: 'N',
      creditLimit: 100,
    })
    expect(res.status).toBe(201)
  })
})

// ──────────────────────────────────────────────────────────────────────
// parsePeriod (via agent-breakdown)
// ──────────────────────────────────────────────────────────────────────

describe('parsePeriod', () => {
  test('rejects unknown period with 400 bad_request', async () => {
    seedMember()
    const res = await call('GET', PATH('agent-breakdown') + '?period=ever')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(res.body.error.message).toContain("Invalid period 'ever'")
  })

  test.each(['7d', '30d', '90d', '1y'])('accepts %s', async (period) => {
    seedMember()
    const res = await call('GET', PATH('agent-breakdown') + `?period=${period}`)
    expect(res.status).toBe(200)
    expect(svcSpies.getAgentCostBreakdown).toHaveBeenCalledWith(WS, period, undefined)
  })

  test('defaults to 30d when omitted', async () => {
    seedMember()
    await call('GET', PATH('agent-breakdown'))
    expect(svcSpies.getAgentCostBreakdown.mock.calls[0][1]).toBe('30d')
  })
})

// ──────────────────────────────────────────────────────────────────────
// agent-breakdown / recommendations / trends
// ──────────────────────────────────────────────────────────────────────

describe('agent-breakdown / recommendations / trends', () => {
  beforeEach(() => seedMember())

  test('agent-breakdown forwards projectId from query', async () => {
    await call('GET', PATH('agent-breakdown') + '?projectId=proj_a&period=7d')
    expect(svcSpies.getAgentCostBreakdown).toHaveBeenCalledWith(WS, '7d', 'proj_a')
  })

  test('recommendations: returns 200 with data envelope', async () => {
    svcSpies.getCostRecommendations.mockImplementationOnce(async () => [{ id: 'r1' }])
    const res = await call('GET', PATH('recommendations') + '?period=90d')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, data: [{ id: 'r1' }] })
    expect(svcSpies.getCostRecommendations).toHaveBeenCalledWith(WS, '90d')
  })

  test('trends: forwards projectId when present', async () => {
    await call('GET', PATH('trends') + '?period=1y&projectId=proj_z')
    expect(svcSpies.getCostTrends).toHaveBeenCalledWith(WS, '1y', 'proj_z')
  })

  test('trends without projectId passes undefined', async () => {
    await call('GET', PATH('trends'))
    expect(svcSpies.getCostTrends).toHaveBeenCalledWith(WS, '30d', undefined)
  })

  test('catch branch surfaces cost_analytics_failed', async () => {
    svcSpies.getAgentCostBreakdown.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const res = await call('GET', PATH('agent-breakdown'))
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('cost_analytics_failed')
    expect(res.body.error.message).toBe('boom')
  })
})

// ──────────────────────────────────────────────────────────────────────
// budget-alerts CRUD
// ──────────────────────────────────────────────────────────────────────

describe('budget-alerts', () => {
  test('GET requires only member access', async () => {
    seedMember('viewer')
    svcSpies.getBudgetAlerts.mockImplementationOnce(async () => [{ id: 'ba_1' }])
    const res = await call('GET', PATH('budget-alerts'))
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([{ id: 'ba_1' }])
  })

  test('POST 400 when body is missing name', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('budget-alerts'), { creditLimit: 100 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  test('POST 400 when creditLimit is not a number', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('budget-alerts'), {
      name: 'N',
      creditLimit: 'lots',
    })
    expect(res.status).toBe(400)
  })

  test('POST happy path returns 201 + forwards body', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('budget-alerts'), {
      name: 'Monthly',
      creditLimit: 5000,
      modelFilter: 'sonnet',
    })
    expect(res.status).toBe(201)
    expect(svcSpies.createBudgetAlert).toHaveBeenCalledWith(WS, {
      name: 'Monthly',
      creditLimit: 5000,
      modelFilter: 'sonnet',
    })
  })

  test('PATCH forwards body to service with alertId + workspaceId', async () => {
    seedMember('admin')
    const res = await call('PATCH', PATH('budget-alerts/ba_1'), {
      creditLimit: 9000,
    })
    expect(res.status).toBe(200)
    expect(svcSpies.updateBudgetAlert).toHaveBeenCalledWith('ba_1', WS, { creditLimit: 9000 })
  })

  test('PATCH requires admin', async () => {
    seedMember('viewer')
    const res = await call('PATCH', PATH('budget-alerts/ba_1'), { creditLimit: 9000 })
    expect(res.status).toBe(403)
  })

  test('DELETE removes alert (returns ok:true)', async () => {
    seedMember('admin')
    const res = await call('DELETE', PATH('budget-alerts/ba_1'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(svcSpies.deleteBudgetAlert).toHaveBeenCalledWith('ba_1', WS)
  })

  test('DELETE requires admin', async () => {
    seedMember('editor')
    const res = await call('DELETE', PATH('budget-alerts/ba_1'))
    expect(res.status).toBe(403)
  })

  test('catch branch on POST → 500 cost_analytics_failed', async () => {
    seedMember('admin')
    svcSpies.createBudgetAlert.mockImplementationOnce(async () => {
      throw new Error('db fail')
    })
    const res = await call('POST', PATH('budget-alerts'), { name: 'X', creditLimit: 1 })
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('cost_analytics_failed')
  })
})

// ──────────────────────────────────────────────────────────────────────
// budget-status
// ──────────────────────────────────────────────────────────────────────

describe('budget-status', () => {
  test('derives throttleModel from breached items only', async () => {
    seedMember()
    svcSpies.getBudgetAlertUsage.mockImplementationOnce(async () => [
      { alertId: 'a', percentUsed: 50 },
      { alertId: 'b', percentUsed: 90 },
      { alertId: 'c', percentUsed: 80 },
    ])
    svcSpies.deriveActiveThrottleModel.mockImplementationOnce(() => 'haiku')
    const res = await call('GET', PATH('budget-status'))
    expect(res.status).toBe(200)
    expect(res.body.data.breached.map((b: any) => b.alertId)).toEqual(['b', 'c'])
    expect(res.body.data.throttleModel).toBe('haiku')
    expect(svcSpies.deriveActiveThrottleModel.mock.calls[0][0]).toHaveLength(2)
  })

  test('no breached items → throttleModel=null', async () => {
    seedMember()
    svcSpies.getBudgetAlertUsage.mockImplementationOnce(async () => [
      { alertId: 'a', percentUsed: 10 },
    ])
    const res = await call('GET', PATH('budget-status'))
    expect(res.body.data.breached).toEqual([])
    expect(res.body.data.throttleModel).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────
// experiments
// ──────────────────────────────────────────────────────────────────────

describe('experiments', () => {
  test('GET list returns service payload', async () => {
    seedMember()
    svcSpies.getExperiments.mockImplementationOnce(async () => [{ id: 'e1' }])
    const res = await call('GET', PATH('experiments'))
    expect(res.body.data).toEqual([{ id: 'e1' }])
  })

  test('POST requires admin', async () => {
    seedMember('viewer')
    const res = await call('POST', PATH('experiments'), {
      name: 'N', agentType: 'chat', modelA: 'a', modelB: 'b',
    })
    expect(res.status).toBe(403)
  })

  test('POST 400 when modelA missing', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('experiments'), {
      name: 'N', agentType: 'chat', modelB: 'b',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  test('POST happy path 201', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('experiments'), {
      name: 'N', agentType: 'chat', modelA: 'a', modelB: 'b',
    })
    expect(res.status).toBe(201)
    expect(svcSpies.createExperiment).toHaveBeenCalled()
  })

  test('POST input-error from service surfaces as 400 bad_request', async () => {
    seedMember('admin')
    svcSpies.createExperiment.mockImplementationOnce(async () => {
      throw new Error('modelA and modelB must be different models.')
    })
    const res = await call('POST', PATH('experiments'), {
      name: 'N', agentType: 'chat', modelA: 'a', modelB: 'b',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  test('POST unsupported agentType from service surfaces as 400', async () => {
    seedMember('admin')
    svcSpies.createExperiment.mockImplementationOnce(async () => {
      throw new Error('Unsupported experiment agentType: foo')
    })
    const res = await call('POST', PATH('experiments'), {
      name: 'N', agentType: 'foo', modelA: 'a', modelB: 'b',
    })
    expect(res.status).toBe(400)
  })

  test('POST generic service throw → 500', async () => {
    seedMember('admin')
    svcSpies.createExperiment.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const res = await call('POST', PATH('experiments'), {
      name: 'N', agentType: 'chat', modelA: 'a', modelB: 'b',
    })
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('cost_analytics_failed')
  })

  test('GET :id returns 404 when service returns null', async () => {
    seedMember()
    svcSpies.getExperiment.mockImplementationOnce(async () => null)
    const res = await call('GET', PATH('experiments/exp_999'))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  test('GET :id happy path', async () => {
    seedMember()
    svcSpies.getExperiment.mockImplementationOnce(async () => ({ id: 'exp_1' }))
    const res = await call('GET', PATH('experiments/exp_1'))
    expect(res.body.data).toEqual({ id: 'exp_1' })
  })

  test('POST :id/stop calls stopExperiment', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('experiments/exp_1/stop'))
    expect(res.status).toBe(200)
    expect(svcSpies.stopExperiment).toHaveBeenCalledWith('exp_1', WS)
  })

  test('POST :id/stop requires admin', async () => {
    seedMember('viewer')
    const res = await call('POST', PATH('experiments/exp_1/stop'))
    expect(res.status).toBe(403)
  })
})

// ──────────────────────────────────────────────────────────────────────
// shadow experiment
// ──────────────────────────────────────────────────────────────────────

describe('shadow experiment', () => {
  test('requires admin', async () => {
    seedMember('editor')
    const res = await call('POST', PATH('experiments/shadow'), {
      agentType: 'chat', modelA: 'a', modelB: 'b',
    })
    expect(res.status).toBe(403)
  })

  test('400 on missing field', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('experiments/shadow'), { agentType: 'chat' })
    expect(res.status).toBe(400)
  })

  test('400 on empty body (no JSON)', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('experiments/shadow'), 'not-json')
    expect(res.status).toBe(400)
  })

  test('happy path → 201', async () => {
    seedMember('admin')
    const res = await call('POST', PATH('experiments/shadow'), {
      agentType: 'chat', modelA: 'a', modelB: 'b',
    })
    expect(res.status).toBe(201)
    expect(svcSpies.createShadowExperiment).toHaveBeenCalled()
  })

  test('input-error from service → 400 bad_request', async () => {
    seedMember('admin')
    svcSpies.createShadowExperiment.mockImplementationOnce(async () => {
      throw new Error('modelA and modelB must be different models.')
    })
    const res = await call('POST', PATH('experiments/shadow'), {
      agentType: 'chat', modelA: 'a', modelB: 'b',
    })
    expect(res.status).toBe(400)
  })
})

// ──────────────────────────────────────────────────────────────────────
// summarize / optimizer-in-action / agent-eval-sets
// ──────────────────────────────────────────────────────────────────────

describe('summarize experiment', () => {
  test('404 when service returns null', async () => {
    seedMember()
    svcSpies.summarizeExperiment.mockImplementationOnce(async () => null)
    const res = await call('GET', PATH('experiments/exp_ghost/summary'))
    expect(res.status).toBe(404)
  })

  test('happy path', async () => {
    seedMember()
    svcSpies.summarizeExperiment.mockImplementationOnce(async () => ({ verdict: 'A' }))
    const res = await call('GET', PATH('experiments/exp_1/summary'))
    expect(res.body.data).toEqual({ verdict: 'A' })
  })
})

describe('optimizer-in-action', () => {
  test('member access required', async () => {
    const res = await call('GET', PATH('optimizer-in-action'))
    expect(res.status).toBe(403)
  })

  test('returns report from service', async () => {
    seedMember()
    svcSpies.getOptimizerInActionReport.mockImplementationOnce(async () => ({
      appliedOverrides: [],
      savings: 42,
    }))
    const res = await call('GET', PATH('optimizer-in-action'))
    expect(res.status).toBe(200)
    expect(res.body.data.savings).toBe(42)
  })
})

describe('agent-eval-sets list', () => {
  test('parses agentType / projectId / enabled query params', async () => {
    seedMember()
    await call(
      'GET',
      PATH('agent-eval-sets') + '?agentType=chat&projectId=proj_x&enabled=true',
    )
    expect(svcSpies.listAgentEvalSets).toHaveBeenCalledWith({
      workspaceId: WS,
      agentType: 'chat',
      projectId: 'proj_x',
      enabled: true,
    })
  })

  test('enabled=false propagates', async () => {
    seedMember()
    await call('GET', PATH('agent-eval-sets') + '?enabled=false')
    expect(svcSpies.listAgentEvalSets.mock.calls[0][0].enabled).toBe(false)
  })

  test('missing optional params → undefined', async () => {
    seedMember()
    await call('GET', PATH('agent-eval-sets'))
    const arg = svcSpies.listAgentEvalSets.mock.calls[0][0]
    expect(arg.agentType).toBeUndefined()
    expect(arg.projectId).toBeUndefined()
    expect(arg.enabled).toBeUndefined()
  })
})
