// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/internal.ts` — cluster-internal API endpoints.
 *
 * Covers all endpoints + auth helper:
 *   - GET /pod-config/:projectId           — K8s SA auth, rate limit, warm-pool env build
 *   - GET /whoami/:serviceName             — serviceName regex guard, K8s SA auth, prisma lookup
 *   - POST /heartbeat/complete             — body validation, validateAuth, prisma update
 *   - PUT /heartbeat/config/:projectId     — validateAuth, body field filtering,
 *                                            enabled→nextHeartbeatAt scheduling,
 *                                            disabled→null nextHeartbeatAt, 404 missing config
 *   - POST /validate-preview-token         — auth, body json/required, verifyPreviewToken paths
 *   - POST /validate-runtime-token         — auth, body json/required, verifyRuntimeToken paths
 *   - GET /subagent-overrides/resolve      — query params, override + experiment fallback
 *   - POST /agent-cost-metrics             — body validation, validateAuth, numberOr coercion
 *   - POST /agent-eval-results             — totalCases > 0, passedCases bounds, persistence
 *
 * Auth helpers (`validateAuth`) tested via endpoint behaviour:
 *   - SHOGO_LOCAL_MODE=true + x-runtime-token branch
 *   - K8s SA bearer token branch
 *   - 401 when no credentials match
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Mocks for all transient dependencies ─────────────────────────────

const k8sAuth = {
  validatePodToken: mock(async (_t: string) =>
    null as null | { serviceAccountName: string; namespace: string },
  ),
}
mock.module('../lib/k8s-auth', () => k8sAuth)

const runtimeToken = {
  verifyRuntimeToken: mock((_t: string, _p?: string) =>
    ({ ok: false, reason: 'bad' } as
      | { ok: false; reason: string }
      | { ok: true; projectId: string; format: string }),
  ),
}
mock.module('../lib/runtime-token', () => runtimeToken)

const previewToken = {
  verifyPreviewToken: mock(async (_t: string) =>
    null as null | { projectId: string; exp: number },
  ),
}
mock.module('../lib/preview-token', () => previewToken)

let buildProjectEnvImpl: (projectId: string) => Promise<Record<string, string>> =
  async () => ({ PROJECT_ID: 'p1', FOO: 'bar' })
const warmPoolMock = {
  getWarmPoolController: () => ({
    buildProjectEnv: (id: string) => buildProjectEnvImpl(id),
  }),
}
mock.module('../lib/warm-pool-controller', () => warmPoolMock)

// Prisma mock
let projectFindFirstImpl: (args: any) => Promise<any> = async () => null
let agentConfigState: Map<string, any>
const prismaMock = {
  project: {
    findFirst: (args: any) => projectFindFirstImpl(args),
  },
  agentConfig: {
    findUnique: async ({ where }: any) => agentConfigState.get(where.projectId) ?? null,
    update: async ({ where, data }: any) => {
      const row = agentConfigState.get(where.projectId)
      if (!row) throw new Error('not found')
      Object.assign(row, data)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const [, row] of agentConfigState) {
        if (row.projectId === where.projectId) {
          Object.assign(row, data)
          count++
        }
      }
      return { count }
    },
  },
}
mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

// cost-analytics.service mock
const costAnalytics = {
  resolveSubagentModelOverride: mock(
    async (_w: string, _a: string, _p?: string) =>
      null as null | { model: string; provider: string; source: string },
  ),
  pickExperimentModel: mock(
    async (_w: string, _a: string, _b?: string) =>
      null as null | { model: string; variant: string },
  ),
  recordAgentCostMetric: mock(async (_args: any) => undefined),
  recordAgentEvalResult: mock(async (_args: any) => ({ id: 'eval_1', passRate: 1.0 })),
}
mock.module('../services/cost-analytics.service', () => costAnalytics)

// ─── Import after mocks ──────────────────────────────────────────────

const app = (await import('../routes/internal')).default

// ─── Helpers ────────────────────────────────────────────────────────

function k8sHeaders(token = 'sa.token') {
  return { Authorization: `Bearer ${token}` }
}

function jsonReq(headers: Record<string, string> = {}, body?: any): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

const ORIG_LOCAL_MODE = process.env.SHOGO_LOCAL_MODE

afterEach(() => {
  if (ORIG_LOCAL_MODE === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = ORIG_LOCAL_MODE
})

beforeEach(() => {
  k8sAuth.validatePodToken.mockClear()
  k8sAuth.validatePodToken.mockImplementation(async () => null)
  runtimeToken.verifyRuntimeToken.mockClear()
  runtimeToken.verifyRuntimeToken.mockImplementation(() => ({ ok: false, reason: 'bad' }))
  previewToken.verifyPreviewToken.mockClear()
  previewToken.verifyPreviewToken.mockImplementation(async () => null)
  buildProjectEnvImpl = async () => ({ PROJECT_ID: 'p1', FOO: 'bar' })
  projectFindFirstImpl = async () => null
  agentConfigState = new Map()
  costAnalytics.resolveSubagentModelOverride.mockClear()
  costAnalytics.resolveSubagentModelOverride.mockImplementation(async () => null)
  costAnalytics.pickExperimentModel.mockClear()
  costAnalytics.pickExperimentModel.mockImplementation(async () => null)
  costAnalytics.recordAgentCostMetric.mockClear()
  costAnalytics.recordAgentCostMetric.mockImplementation(async () => undefined)
  costAnalytics.recordAgentEvalResult.mockClear()
  costAnalytics.recordAgentEvalResult.mockImplementation(async () => ({ id: 'eval_1', passRate: 1.0 }))
})

// ═══════════════════════════════════════════════════════════════════════
// GET /pod-config/:projectId
// ═══════════════════════════════════════════════════════════════════════

describe('GET /pod-config/:projectId', () => {
  test('401 when Authorization header missing', async () => {
    const res = await app.request('/pod-config/proj_1')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/Authorization/)
  })

  test('401 when header is not a Bearer token', async () => {
    const res = await app.request('/pod-config/proj_1', { headers: { Authorization: 'Basic abc' } })
    expect(res.status).toBe(401)
  })

  test('403 when token is invalid', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => null)
    const res = await app.request('/pod-config/proj_1', { headers: k8sHeaders() })
    expect(res.status).toBe(403)
  })

  test('happy path returns env from warm pool', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'agent-runtime', namespace: 'default',
    }))
    buildProjectEnvImpl = async () => ({ PROJECT_ID: 'p1', DATABASE_URL: 'postgres://x' })
    const res = await app.request('/pod-config/p1', { headers: k8sHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ projectId: 'p1', env: { PROJECT_ID: 'p1', DATABASE_URL: 'postgres://x' } })
  })

  test('500 when warm pool throws', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'agent-runtime', namespace: 'default',
    }))
    buildProjectEnvImpl = async () => { throw new Error('warm pool down') }
    const res = await app.request('/pod-config/p1', { headers: k8sHeaders() })
    expect(res.status).toBe(500)
  })

  test('rate limit: 6th request within window returns 429', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'agent-runtime', namespace: 'default',
    }))
    const id = `rl_${Date.now()}`
    for (let i = 0; i < 5; i++) {
      const r = await app.request(`/pod-config/${id}`, { headers: k8sHeaders() })
      expect(r.status).toBe(200)
    }
    const sixth = await app.request(`/pod-config/${id}`, { headers: k8sHeaders() })
    expect(sixth.status).toBe(429)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// GET /whoami/:serviceName
// ═══════════════════════════════════════════════════════════════════════

describe('GET /whoami/:serviceName', () => {
  test('400 when service name violates RFC 1123 (uppercase)', async () => {
    const res = await app.request('/whoami/UPPER', { headers: k8sHeaders() })
    expect(res.status).toBe(400)
  })

  test('400 when service name has trailing dash', async () => {
    const res = await app.request('/whoami/foo-', { headers: k8sHeaders() })
    expect(res.status).toBe(400)
  })

  test('401 when no Authorization header', async () => {
    const res = await app.request('/whoami/svc-1')
    expect(res.status).toBe(401)
  })

  test('403 when SA token invalid', async () => {
    const res = await app.request('/whoami/svc-1', { headers: k8sHeaders() })
    expect(res.status).toBe(403)
  })

  test('happy path returns projectId from prisma lookup', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    projectFindFirstImpl = async () => ({ id: 'proj_xyz' })
    const res = await app.request('/whoami/svc-name', { headers: k8sHeaders() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projectId: 'proj_xyz' })
  })

  test('returns null projectId when service is in pool', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    projectFindFirstImpl = async () => null
    const res = await app.request('/whoami/svc-pool', { headers: k8sHeaders() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projectId: null })
  })

  test('500 when prisma lookup throws', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    projectFindFirstImpl = async () => { throw new Error('db down') }
    const res = await app.request('/whoami/svc-1', { headers: k8sHeaders() })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /heartbeat/complete
// ═══════════════════════════════════════════════════════════════════════

describe('POST /heartbeat/complete', () => {
  test('400 when projectId missing', async () => {
    const res = await app.request('/heartbeat/complete', jsonReq(k8sHeaders(), {}))
    expect(res.status).toBe(400)
  })

  test('400 when projectId is not a string', async () => {
    const res = await app.request('/heartbeat/complete', jsonReq(k8sHeaders(), { projectId: 123 }))
    expect(res.status).toBe(400)
  })

  test('401 when no auth', async () => {
    const res = await app.request('/heartbeat/complete', jsonReq({}, { projectId: 'p1' }))
    expect(res.status).toBe(401)
  })

  test('happy path returns ok with K8s SA token', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    agentConfigState.set('p1', { projectId: 'p1', lastHeartbeatAt: null })
    const res = await app.request('/heartbeat/complete', jsonReq(k8sHeaders(), { projectId: 'p1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(agentConfigState.get('p1').lastHeartbeatAt).toBeInstanceOf(Date)
  })

  test('happy path with local-mode runtime token', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    runtimeToken.verifyRuntimeToken.mockImplementation(() => ({ ok: true, projectId: 'p1', format: 'v1' }))
    agentConfigState.set('p1', { projectId: 'p1', lastHeartbeatAt: null })
    const res = await app.request('/heartbeat/complete', jsonReq(
      { 'x-runtime-token': 'rt' },
      { projectId: 'p1' },
    ))
    expect(res.status).toBe(200)
  })

  test('runtime token: 401 when token projectId does not match body projectId', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    runtimeToken.verifyRuntimeToken.mockImplementation(() => ({ ok: true, projectId: 'other', format: 'v1' }))
    const res = await app.request('/heartbeat/complete', jsonReq(
      { 'x-runtime-token': 'rt' },
      { projectId: 'p1' },
    ))
    expect(res.status).toBe(401)
  })

  test('runtime token: not honored when SHOGO_LOCAL_MODE is not true', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    runtimeToken.verifyRuntimeToken.mockImplementation(() => ({ ok: true, projectId: 'p1', format: 'v1' }))
    const res = await app.request('/heartbeat/complete', jsonReq(
      { 'x-runtime-token': 'rt' },
      { projectId: 'p1' },
    ))
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// PUT /heartbeat/config/:projectId
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /heartbeat/config/:projectId', () => {
  function put(projectId: string, body: any, headers = k8sHeaders()) {
    return app.request(`/heartbeat/config/${projectId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  test('401 without auth', async () => {
    const res = await put('p1', {}, {} as any)
    expect(res.status).toBe(401)
  })

  test('404 when agent config not found', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await put('p_missing', { heartbeatEnabled: true, heartbeatInterval: 60 })
    expect(res.status).toBe(404)
  })

  test('enables and schedules nextHeartbeatAt in the future', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    agentConfigState.set('p1', {
      projectId: 'p1',
      heartbeatEnabled: false,
      heartbeatInterval: 60,
      nextHeartbeatAt: null,
    })
    const before = Date.now()
    const res = await put('p1', { heartbeatEnabled: true, heartbeatInterval: 120 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const scheduled = new Date(body.nextHeartbeatAt).getTime()
    expect(scheduled).toBeGreaterThanOrEqual(before + 120_000)
    // jitter ≤ 10% of interval
    expect(scheduled).toBeLessThanOrEqual(before + 120_000 + 12_000 + 1_000)
    expect(agentConfigState.get('p1').heartbeatEnabled).toBe(true)
    expect(agentConfigState.get('p1').heartbeatInterval).toBe(120)
  })

  test('disabling clears nextHeartbeatAt', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    agentConfigState.set('p1', {
      projectId: 'p1', heartbeatEnabled: true, heartbeatInterval: 60,
      nextHeartbeatAt: new Date(Date.now() + 60_000),
    })
    const res = await put('p1', { heartbeatEnabled: false })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nextHeartbeatAt).toBe(null)
    expect(agentConfigState.get('p1').nextHeartbeatAt).toBe(null)
  })

  test('rejects interval < 60 (ignored, not error)', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    agentConfigState.set('p1', {
      projectId: 'p1', heartbeatEnabled: true, heartbeatInterval: 300, nextHeartbeatAt: null,
    })
    const res = await put('p1', { heartbeatInterval: 30 })
    expect(res.status).toBe(200)
    expect(agentConfigState.get('p1').heartbeatInterval).toBe(300)
  })

  test('quietHoursStart empty string is mapped to null', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    agentConfigState.set('p1', {
      projectId: 'p1', heartbeatEnabled: false, heartbeatInterval: 60,
      quietHoursStart: '22:00', quietHoursEnd: '06:00', quietHoursTimezone: 'UTC',
    })
    const res = await put('p1', { quietHoursStart: '', quietHoursEnd: '', quietHoursTimezone: '' })
    expect(res.status).toBe(200)
    expect(agentConfigState.get('p1').quietHoursStart).toBe(null)
    expect(agentConfigState.get('p1').quietHoursEnd).toBe(null)
    expect(agentConfigState.get('p1').quietHoursTimezone).toBe(null)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /validate-preview-token
// ═══════════════════════════════════════════════════════════════════════

describe('POST /validate-preview-token', () => {
  test('401 without auth', async () => {
    const res = await app.request('/validate-preview-token', jsonReq({}, { token: 't' }))
    expect(res.status).toBe(401)
  })

  test('400 on invalid JSON body', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/validate-preview-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...k8sHeaders() },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  test('400 when token missing', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/validate-preview-token', jsonReq(k8sHeaders(), {}))
    expect(res.status).toBe(400)
  })

  test('valid:false when verifyPreviewToken returns null', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    previewToken.verifyPreviewToken.mockImplementation(async () => null)
    const res = await app.request('/validate-preview-token', jsonReq(k8sHeaders(), { token: 'x' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: false })
  })

  test('valid:true returns projectId + exp', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    previewToken.verifyPreviewToken.mockImplementation(async () => ({
      projectId: 'p9', exp: 9999,
    }))
    const res = await app.request('/validate-preview-token', jsonReq(k8sHeaders(), { token: 'x' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: true, projectId: 'p9', exp: 9999 })
  })

  test('500 when verifyPreviewToken throws', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    previewToken.verifyPreviewToken.mockImplementation(async () => { throw new Error('boom') })
    const res = await app.request('/validate-preview-token', jsonReq(k8sHeaders(), { token: 'x' }))
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /validate-runtime-token
// ═══════════════════════════════════════════════════════════════════════

describe('POST /validate-runtime-token', () => {
  test('401 without auth', async () => {
    const res = await app.request('/validate-runtime-token', jsonReq({}, { token: 't' }))
    expect(res.status).toBe(401)
  })

  test('400 on invalid JSON', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/validate-runtime-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...k8sHeaders() },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  test('400 when token missing', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/validate-runtime-token', jsonReq(k8sHeaders(), {}))
    expect(res.status).toBe(400)
  })

  test('valid:false with reason when verifyRuntimeToken fails', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    runtimeToken.verifyRuntimeToken.mockImplementation(() => ({ ok: false, reason: 'expired' }))
    const res = await app.request('/validate-runtime-token', jsonReq(k8sHeaders(), { token: 'x' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: false, reason: 'expired' })
  })

  test('valid:true returns projectId + format', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    runtimeToken.verifyRuntimeToken.mockImplementation(() => ({
      ok: true, projectId: 'p7', format: 'v1',
    }))
    const res = await app.request('/validate-runtime-token', jsonReq(k8sHeaders(), {
      token: 'x', expectedProjectId: 'p7',
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: true, projectId: 'p7', format: 'v1' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// GET /subagent-overrides/resolve
// ═══════════════════════════════════════════════════════════════════════

describe('GET /subagent-overrides/resolve', () => {
  test('400 when workspaceId missing', async () => {
    const res = await app.request('/subagent-overrides/resolve?agentType=planner', { headers: k8sHeaders() })
    expect(res.status).toBe(400)
  })

  test('400 when agentType missing', async () => {
    const res = await app.request('/subagent-overrides/resolve?workspaceId=w1', { headers: k8sHeaders() })
    expect(res.status).toBe(400)
  })

  test('401 without auth', async () => {
    const res = await app.request('/subagent-overrides/resolve?workspaceId=w1&agentType=planner')
    expect(res.status).toBe(401)
  })

  test('returns override when present, skips experiment lookup', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    costAnalytics.resolveSubagentModelOverride.mockImplementation(async () => ({
      model: 'gpt-4o', provider: 'openai', source: 'workspace',
    }))
    const res = await app.request('/subagent-overrides/resolve?workspaceId=w1&agentType=planner', { headers: k8sHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.override.model).toBe('gpt-4o')
    expect(body.experiment).toBe(null)
    expect(costAnalytics.pickExperimentModel).not.toHaveBeenCalled()
  })

  test('falls back to experiment when no override', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    costAnalytics.resolveSubagentModelOverride.mockImplementation(async () => null)
    costAnalytics.pickExperimentModel.mockImplementation(async () => ({
      model: 'claude', variant: 'B',
    }))
    const res = await app.request(
      '/subagent-overrides/resolve?workspaceId=w1&agentType=planner&bucketKey=run_1',
      { headers: k8sHeaders() },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.override).toBe(null)
    expect(body.experiment.model).toBe('claude')
    expect(costAnalytics.pickExperimentModel.mock.calls[0]).toEqual(['w1', 'planner', 'run_1'])
  })

  test('500 when service throws', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    costAnalytics.resolveSubagentModelOverride.mockImplementation(async () => { throw new Error('x') })
    const res = await app.request(
      '/subagent-overrides/resolve?workspaceId=w1&agentType=planner',
      { headers: k8sHeaders() },
    )
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /agent-cost-metrics
// ═══════════════════════════════════════════════════════════════════════

describe('POST /agent-cost-metrics', () => {
  test('400 on invalid JSON body', async () => {
    const res = await app.request('/agent-cost-metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...k8sHeaders() },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  test('401 when no auth', async () => {
    const res = await app.request('/agent-cost-metrics', jsonReq({}, {
      workspaceId: 'w', agentType: 'a', model: 'm',
    }))
    expect(res.status).toBe(401)
  })

  test('400 when workspaceId missing', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/agent-cost-metrics', jsonReq(k8sHeaders(), {
      agentType: 'a', model: 'm',
    }))
    expect(res.status).toBe(400)
  })

  test('400 when agentType missing', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/agent-cost-metrics', jsonReq(k8sHeaders(), {
      workspaceId: 'w', model: 'm',
    }))
    expect(res.status).toBe(400)
  })

  test('happy path coerces numbers and forwards to service', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/agent-cost-metrics', jsonReq(k8sHeaders(), {
      workspaceId: 'w1', agentType: 'planner', model: 'gpt-4o',
      inputTokens: 100, outputTokens: 50, toolCalls: 'bad',
      creditCost: 1.5, wallTimeMs: 1000,
      hitMaxTurns: true, loopDetected: 'yes',
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const args = costAnalytics.recordAgentCostMetric.mock.calls[0][0]
    expect(args.workspaceId).toBe('w1')
    expect(args.inputTokens).toBe(100)
    expect(args.outputTokens).toBe(50)
    expect(args.toolCalls).toBe(0) // coerced from non-number
    expect(args.hitMaxTurns).toBe(true)
    expect(args.loopDetected).toBe(false) // string 'yes' is not boolean true
    expect(args.success).toBe(true) // not provided → defaults to true
  })

  test('success: false when explicitly false', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    await app.request('/agent-cost-metrics', jsonReq(k8sHeaders(), {
      workspaceId: 'w1', agentType: 'a', model: 'm', success: false,
    }))
    expect(costAnalytics.recordAgentCostMetric.mock.calls[0][0].success).toBe(false)
  })

  test('500 when service throws', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    costAnalytics.recordAgentCostMetric.mockImplementation(async () => { throw new Error('x') })
    const res = await app.request('/agent-cost-metrics', jsonReq(k8sHeaders(), {
      workspaceId: 'w1', agentType: 'a', model: 'm',
    }))
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /agent-eval-results
// ═══════════════════════════════════════════════════════════════════════

describe('POST /agent-eval-results', () => {
  test('400 on invalid JSON', async () => {
    const res = await app.request('/agent-eval-results', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...k8sHeaders() },
      body: 'nope',
    })
    expect(res.status).toBe(400)
  })

  test('401 when no auth', async () => {
    const res = await app.request('/agent-eval-results', jsonReq({}, {
      agentType: 'a', model: 'm', suite: 's', totalCases: 10, passedCases: 9,
    }))
    expect(res.status).toBe(401)
  })

  test('400 when required fields missing', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/agent-eval-results', jsonReq(k8sHeaders(), {
      model: 'm', suite: 's', totalCases: 1, passedCases: 1,
    }))
    expect(res.status).toBe(400)
  })

  test('400 when totalCases <= 0', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/agent-eval-results', jsonReq(k8sHeaders(), {
      agentType: 'a', model: 'm', suite: 's', totalCases: 0, passedCases: 0,
    }))
    expect(res.status).toBe(400)
  })

  test('400 when passedCases > totalCases', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/agent-eval-results', jsonReq(k8sHeaders(), {
      agentType: 'a', model: 'm', suite: 's', totalCases: 5, passedCases: 6,
    }))
    expect(res.status).toBe(400)
  })

  test('400 when passedCases < 0', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    const res = await app.request('/agent-eval-results', jsonReq(k8sHeaders(), {
      agentType: 'a', model: 'm', suite: 's', totalCases: 5, passedCases: -1,
    }))
    expect(res.status).toBe(400)
  })

  test('happy path returns id + passRate', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    costAnalytics.recordAgentEvalResult.mockImplementation(async () => ({ id: 'eval_99', passRate: 0.9 }))
    const res = await app.request('/agent-eval-results', jsonReq(k8sHeaders(), {
      agentType: 'planner', model: 'gpt-4o', suite: 'agentic',
      totalCases: 10, passedCases: 9, avgWallTimeMs: 1234,
      metadata: { commit: 'abc' },
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, id: 'eval_99', passRate: 0.9 })
    const args = costAnalytics.recordAgentEvalResult.mock.calls[0][0]
    expect(args.workspaceId).toBe(null) // not provided → null
    expect(args.metadata).toEqual({ commit: 'abc' })
  })

  test('500 when service throws', async () => {
    k8sAuth.validatePodToken.mockImplementation(async () => ({
      serviceAccountName: 'sa', namespace: 'ns',
    }))
    costAnalytics.recordAgentEvalResult.mockImplementation(async () => { throw new Error('x') })
    const res = await app.request('/agent-eval-results', jsonReq(k8sHeaders(), {
      agentType: 'a', model: 'm', suite: 's', totalCases: 1, passedCases: 1,
    }))
    expect(res.status).toBe(500)
  })
})
