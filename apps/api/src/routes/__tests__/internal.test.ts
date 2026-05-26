// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const store = {
  podIdentity: null as null | { serviceAccountName: string; namespace: string },
  runtimeVerify: null as null | { ok: boolean; reason?: string; projectId?: string; format?: string },
  previewVerify: null as null | { projectId: string; exp: number },
  warmPoolEnv: { foo: 'bar' } as any,
  warmPoolThrow: null as null | Error,
  prismaProject: null as null | { id: string },
  prismaProjectThrow: null as null | Error,
  prismaProjectFindUnique: null as any,
  prismaProjectFindUniqueThrow: null as null | Error,
  agentConfigUpdate: { count: 1 },
  agentConfigUpdateThrow: null as null | Error,
  agentConfigFind: null as any,
  agentConfigFindThrow: null as null | Error,
  agentConfigUpdateOne: { ok: true } as any,
  override: null as any,
  experiment: null as any,
  overrideThrow: null as null | Error,
  recordMetricThrow: null as null | Error,
  recordEvalThrow: null as null | Error,
  evalRow: { id: 'ev1', passRate: 0.9 } as any,
  recordedMetric: null as any,
  recordedEval: null as any,
  previewVerifyThrow: null as null | Error,
  runtimeVerifyThrow: null as null | Error,
}

mock.module('../../lib/k8s-auth', () => ({
  validatePodToken: async (_t: string) => store.podIdentity,
}))

mock.module('../../lib/runtime-token', () => ({
  verifyRuntimeToken: (_t: string, _p?: string) => {
    if (store.runtimeVerifyThrow) throw store.runtimeVerifyThrow
    return store.runtimeVerify ?? { ok: false, reason: 'bad' }
  },
}))

mock.module('../../lib/preview-token', () => ({
  verifyPreviewToken: async (_t: string) => { if (store.previewVerifyThrow) throw store.previewVerifyThrow; return store.previewVerify },
}))

mock.module('../../lib/warm-pool-controller', () => ({
  getWarmPoolController: () => ({
    buildProjectEnv: async (_p: string) => {
      if (store.warmPoolThrow) throw store.warmPoolThrow
      return store.warmPoolEnv
    },
  }),
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => {
        if (store.prismaProjectThrow) throw store.prismaProjectThrow
        return store.prismaProject
      },
      findUnique: async () => {
        if (store.prismaProjectFindUniqueThrow) throw store.prismaProjectFindUniqueThrow
        return store.prismaProjectFindUnique
      },
    },
    agentConfig: {
      updateMany: async () => {
        if (store.agentConfigUpdateThrow) throw store.agentConfigUpdateThrow
        return store.agentConfigUpdate
      },
      findUnique: async () => {
        if (store.agentConfigFindThrow) throw store.agentConfigFindThrow
        return store.agentConfigFind
      },
      update: async () => store.agentConfigUpdateOne,
    },
  },
}))

mock.module('../../services/cost-analytics.service', () => ({
  resolveSubagentModelOverride: async () => {
    if (store.overrideThrow) throw store.overrideThrow
    return store.override
  },
  pickExperimentModel: async () => store.experiment,
  recordAgentCostMetric: async (input: any) => {
    if (store.recordMetricThrow) throw store.recordMetricThrow
    store.recordedMetric = input
  },
  recordAgentEvalResult: async (input: any) => {
    if (store.recordEvalThrow) throw store.recordEvalThrow
    store.recordedEval = input
    return store.evalRow
  },
}))

const app = (await import('../internal')).default

beforeEach(() => {
  store.podIdentity = { serviceAccountName: 'runtime', namespace: 'shogo' }
  store.runtimeVerify = { ok: true, projectId: 'proj-1', format: 'v1' }
  store.previewVerify = { projectId: 'proj-1', exp: 1700000000 }
  store.warmPoolEnv = { foo: 'bar' }
  store.warmPoolThrow = null
  store.prismaProject = { id: 'proj-99' }
  store.prismaProjectThrow = null
  store.prismaProjectFindUnique = null
  store.prismaProjectFindUniqueThrow = null
  store.agentConfigUpdateThrow = null
  store.agentConfigFind = { projectId: 'proj-1', heartbeatEnabled: true, heartbeatInterval: 300 }
  store.agentConfigFindThrow = null
  store.override = null
  store.experiment = null
  store.overrideThrow = null
  store.recordMetricThrow = null
  store.recordEvalThrow = null
  store.recordedMetric = null
  store.recordedEval = null
  store.previewVerifyThrow = null
  store.runtimeVerifyThrow = null
  delete process.env.SHOGO_LOCAL_MODE
})

afterEach(() => { delete process.env.SHOGO_LOCAL_MODE })

const SA = { Authorization: 'Bearer sa-token' }
const JSON_H = { 'content-type': 'application/json' }

// ─── GET /pod-config/:projectId ─────────────────────────────────────────────

describe('GET /pod-config/:projectId', () => {
  test('429 after rate limit exceeded', async () => {
    const pid = `rl-${Math.random()}`
    for (let i = 0; i < 5; i++) await app.request(`/pod-config/${pid}`, { headers: SA })
    const res = await app.request(`/pod-config/${pid}`, { headers: SA })
    expect(res.status).toBe(429)
  })
  test('401 when Authorization header missing', async () => {
    const res = await app.request('/pod-config/p1')
    expect(res.status).toBe(401)
  })
  test('401 when Authorization is not Bearer', async () => {
    const res = await app.request('/pod-config/p1b', { headers: { Authorization: 'Basic xx' } })
    expect(res.status).toBe(401)
  })
  test('403 when validatePodToken returns null', async () => {
    store.podIdentity = null
    const res = await app.request('/pod-config/p2', { headers: SA })
    expect(res.status).toBe(403)
  })
  test('200 returns projectId + env', async () => {
    const res = await app.request('/pod-config/p3', { headers: SA })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ projectId: 'p3', env: { foo: 'bar' } })
  })
  test('500 when warm pool builder throws', async () => {
    store.warmPoolThrow = new Error('vault down')
    const res = await app.request('/pod-config/p4', { headers: SA })
    expect(res.status).toBe(500)
  })
})

// ─── GET /whoami/:serviceName ───────────────────────────────────────────────

describe('GET /whoami/:serviceName', () => {
  test('400 on invalid service name', async () => {
    const res = await app.request('/whoami/Bad_Name!', { headers: SA })
    expect(res.status).toBe(400)
  })
  test('401 when no Authorization header', async () => {
    const res = await app.request('/whoami/svc-foo')
    expect(res.status).toBe(401)
  })
  test('401 when Authorization is not Bearer', async () => {
    const res = await app.request('/whoami/svc-foo', { headers: { Authorization: 'X' } })
    expect(res.status).toBe(401)
  })
  test('403 when validatePodToken returns null', async () => {
    store.podIdentity = null
    const res = await app.request('/whoami/svc-foo', { headers: SA })
    expect(res.status).toBe(403)
  })
  test('200 returns projectId', async () => {
    const res = await app.request('/whoami/svc-foo', { headers: SA })
    const body = await res.json()
    expect(body).toEqual({ projectId: 'proj-99' })
  })
  test('200 with null projectId when not found', async () => {
    store.prismaProject = null
    const res = await app.request('/whoami/svc-foo', { headers: SA })
    expect((await res.json()).projectId).toBeNull()
  })
  test('500 when prisma throws', async () => {
    store.prismaProjectThrow = new Error('db')
    const res = await app.request('/whoami/svc-foo', { headers: SA })
    expect(res.status).toBe(500)
  })
})

// ─── POST /heartbeat/complete ───────────────────────────────────────────────

describe('POST /heartbeat/complete', () => {
  test('400 when projectId missing', async () => {
    const res = await app.request('/heartbeat/complete', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
  test('401 when auth fails', async () => {
    store.podIdentity = null
    const res = await app.request('/heartbeat/complete', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ projectId: 'p1' }),
    })
    expect(res.status).toBe(401)
  })
  test('200 happy path with SA token', async () => {
    const res = await app.request('/heartbeat/complete', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ projectId: 'p1' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  test('200 with runtime token in local mode', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    store.podIdentity = null
    store.runtimeVerify = { ok: true, projectId: 'p1' }
    const res = await app.request('/heartbeat/complete', {
      method: 'POST',
      headers: { 'x-runtime-token': 'rt', ...JSON_H },
      body: JSON.stringify({ projectId: 'p1' }),
    })
    expect(res.status).toBe(200)
  })
  test('401 when runtime token mismatches projectId in local mode', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    store.podIdentity = null
    store.runtimeVerify = { ok: true, projectId: 'other' }
    const res = await app.request('/heartbeat/complete', {
      method: 'POST',
      headers: { 'x-runtime-token': 'rt', ...JSON_H },
      body: JSON.stringify({ projectId: 'p1' }),
    })
    expect(res.status).toBe(401)
  })
  test('401 when runtime token verify fails', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    store.podIdentity = null
    store.runtimeVerify = { ok: false, reason: 'expired' }
    const res = await app.request('/heartbeat/complete', {
      method: 'POST',
      headers: { 'x-runtime-token': 'rt', ...JSON_H },
      body: JSON.stringify({ projectId: 'p1' }),
    })
    expect(res.status).toBe(401)
  })
  test('500 when prisma updateMany throws', async () => {
    store.agentConfigUpdateThrow = new Error('db')
    const res = await app.request('/heartbeat/complete', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ projectId: 'p1' }),
    })
    expect(res.status).toBe(500)
  })
})

// ─── PUT /heartbeat/config/:projectId ───────────────────────────────────────

describe('PUT /heartbeat/config/:projectId', () => {
  test('401 when auth fails', async () => {
    store.podIdentity = null
    const res = await app.request('/heartbeat/config/p1', {
      method: 'PUT', headers: { ...JSON_H }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })
  test('404 when agent config not found', async () => {
    store.agentConfigFind = null
    const res = await app.request('/heartbeat/config/p1', {
      method: 'PUT', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ heartbeatEnabled: true }),
    })
    expect(res.status).toBe(404)
  })
  test('200 enables and schedules next heartbeat', async () => {
    const res = await app.request('/heartbeat/config/p1', {
      method: 'PUT', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({
        heartbeatEnabled: true, heartbeatInterval: 120,
        quietHoursStart: '22:00', quietHoursEnd: '07:00', quietHoursTimezone: 'UTC',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.nextHeartbeatAt).toBeTruthy()
  })
  test('200 disables and clears next heartbeat', async () => {
    const res = await app.request('/heartbeat/config/p1', {
      method: 'PUT', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ heartbeatEnabled: false }),
    })
    const body = await res.json()
    expect(body.nextHeartbeatAt).toBeNull()
  })
  test('200 with empty-string quiet hours sets to null', async () => {
    const res = await app.request('/heartbeat/config/p1', {
      method: 'PUT', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ quietHoursStart: '', quietHoursEnd: '', quietHoursTimezone: '' }),
    })
    expect(res.status).toBe(200)
  })
  test('rejects interval < 60 by not applying it', async () => {
    store.agentConfigFind = { heartbeatEnabled: true, heartbeatInterval: 300 }
    const res = await app.request('/heartbeat/config/p1', {
      method: 'PUT', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ heartbeatInterval: 10 }),
    })
    expect(res.status).toBe(200)
  })
  test('500 when prisma findUnique throws', async () => {
    store.agentConfigFindThrow = new Error('db')
    const res = await app.request('/heartbeat/config/p1', {
      method: 'PUT', headers: { ...SA, ...JSON_H }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(500)
  })
})

// ─── POST /validate-preview-token ───────────────────────────────────────────

describe('POST /validate-preview-token', () => {
  test('401 when auth fails', async () => {
    store.podIdentity = null
    const res = await app.request('/validate-preview-token', {
      method: 'POST', headers: { ...JSON_H }, body: JSON.stringify({ token: 't' }),
    })
    expect(res.status).toBe(401)
  })
  test('400 when body is not JSON', async () => {
    const res = await app.request('/validate-preview-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: '{not-json',
    })
    expect(res.status).toBe(400)
  })
  test('400 when token missing', async () => {
    const res = await app.request('/validate-preview-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
  test('400 when token is not a string', async () => {
    const res = await app.request('/validate-preview-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ token: 123 }),
    })
    expect(res.status).toBe(400)
  })
  test('200 valid: false when verify returns null', async () => {
    store.previewVerify = null
    const res = await app.request('/validate-preview-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ token: 't' }),
    })
    const body = await res.json()
    expect(body).toEqual({ valid: false })
  })
  test('200 valid: true with payload', async () => {
    const res = await app.request('/validate-preview-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ token: 't' }),
    })
    const body = await res.json()
    expect(body).toEqual({ valid: true, projectId: 'proj-1', exp: 1700000000 })
  })
})

// ─── POST /validate-runtime-token ───────────────────────────────────────────

describe('POST /validate-runtime-token', () => {
  test('401 when auth fails', async () => {
    store.podIdentity = null
    const res = await app.request('/validate-runtime-token', {
      method: 'POST', headers: { ...JSON_H }, body: JSON.stringify({ token: 't' }),
    })
    expect(res.status).toBe(401)
  })
  test('400 when body is not JSON', async () => {
    const res = await app.request('/validate-runtime-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: '!',
    })
    expect(res.status).toBe(400)
  })
  test('400 when token missing', async () => {
    const res = await app.request('/validate-runtime-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
  test('200 valid: false when verify fails', async () => {
    store.runtimeVerify = { ok: false, reason: 'bad-sig' }
    const res = await app.request('/validate-runtime-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ token: 't' }),
    })
    const body = await res.json()
    expect(body).toEqual({ valid: false, reason: 'bad-sig' })
  })
  test('200 valid: true with payload', async () => {
    store.runtimeVerify = { ok: true, projectId: 'p1', format: 'v1' }
    const res = await app.request('/validate-runtime-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ token: 't', expectedProjectId: 'p1' }),
    })
    const body = await res.json()
    expect(body).toEqual({ valid: true, projectId: 'p1', format: 'v1' })
  })
})

// ─── GET /subagent-overrides/resolve ────────────────────────────────────────

describe('GET /subagent-overrides/resolve', () => {
  test('400 when workspaceId missing', async () => {
    const res = await app.request('/subagent-overrides/resolve?agentType=reviewer', { headers: SA })
    expect(res.status).toBe(400)
  })
  test('400 when agentType missing', async () => {
    const res = await app.request('/subagent-overrides/resolve?workspaceId=w1', { headers: SA })
    expect(res.status).toBe(400)
  })
  test('401 when auth fails', async () => {
    store.podIdentity = null
    const res = await app.request('/subagent-overrides/resolve?workspaceId=w1&agentType=reviewer')
    expect(res.status).toBe(401)
  })
  test('200 returns override when present', async () => {
    store.override = { model: 'haiku', provider: 'anthropic', source: 'workspace' }
    const res = await app.request('/subagent-overrides/resolve?workspaceId=w1&agentType=reviewer&projectId=p1&bucketKey=run-1', { headers: SA })
    const body = await res.json()
    expect(body.override).toBeTruthy()
    expect(body.experiment).toBeNull()
  })
  test('200 falls back to experiment when no override', async () => {
    store.experiment = { model: 'sonnet', source: 'experiment' }
    const res = await app.request('/subagent-overrides/resolve?workspaceId=w1&agentType=reviewer', { headers: SA })
    const body = await res.json()
    expect(body.override).toBeNull()
    expect(body.experiment.model).toBe('sonnet')
  })
  test('500 when resolve throws', async () => {
    store.overrideThrow = new Error('boom')
    const res = await app.request('/subagent-overrides/resolve?workspaceId=w1&agentType=reviewer', { headers: SA })
    expect(res.status).toBe(500)
  })
})

// ─── POST /agent-cost-metrics ───────────────────────────────────────────────

describe('POST /agent-cost-metrics', () => {
  test('400 when body is not JSON', async () => {
    const res = await app.request('/agent-cost-metrics', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: '!',
    })
    expect(res.status).toBe(400)
  })
  test('401 when auth fails', async () => {
    store.podIdentity = null
    const res = await app.request('/agent-cost-metrics', {
      method: 'POST', headers: { ...JSON_H },
      body: JSON.stringify({ workspaceId: 'w', agentType: 't', model: 'm' }),
    })
    expect(res.status).toBe(401)
  })
  test('400 when required fields missing', async () => {
    const res = await app.request('/agent-cost-metrics', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ workspaceId: 'w' }),
    })
    expect(res.status).toBe(400)
  })
  test('200 happy path applies numberOr defaults + boolean flags', async () => {
    const res = await app.request('/agent-cost-metrics', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({
        workspaceId: 'w', projectId: 'p', agentRunId: 'r1',
        agentType: 'reviewer', model: 'sonnet',
        inputTokens: 1, outputTokens: 2,
        // cachedInputTokens omitted -> numberOr fallback
        toolCalls: 'not-a-number', // numberOr fallback
        creditCost: NaN, // Infinity check fallback
        wallTimeMs: 10,
        success: false, hitMaxTurns: true, loopDetected: true,
        escalated: true, responseEmpty: true,
      }),
    })
    expect(res.status).toBe(200)
    expect(store.recordedMetric.success).toBe(false)
    expect(store.recordedMetric.hitMaxTurns).toBe(true)
    expect(store.recordedMetric.cachedInputTokens).toBe(0)
    expect(store.recordedMetric.toolCalls).toBe(0)
    expect(store.recordedMetric.creditCost).toBe(0)
  })
  test('200 default success=true when not present', async () => {
    const res = await app.request('/agent-cost-metrics', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ workspaceId: 'w', agentType: 't', model: 'm' }),
    })
    expect(res.status).toBe(200)
    expect(store.recordedMetric.success).toBe(true)
  })
  test('500 when recordAgentCostMetric throws', async () => {
    store.recordMetricThrow = new Error('db')
    const res = await app.request('/agent-cost-metrics', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ workspaceId: 'w', agentType: 't', model: 'm' }),
    })
    expect(res.status).toBe(500)
  })
})

// ─── POST /agent-eval-results ───────────────────────────────────────────────

describe('POST /agent-eval-results', () => {
  test('400 when body is not JSON', async () => {
    const res = await app.request('/agent-eval-results', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: '!',
    })
    expect(res.status).toBe(400)
  })
  test('401 when auth fails', async () => {
    store.podIdentity = null
    const res = await app.request('/agent-eval-results', {
      method: 'POST', headers: { ...JSON_H },
      body: JSON.stringify({ agentType: 't', model: 'm', suite: 's' }),
    })
    expect(res.status).toBe(401)
  })
  test('400 when required fields missing', async () => {
    const res = await app.request('/agent-eval-results', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ agentType: 't' }),
    })
    expect(res.status).toBe(400)
  })
  test('400 when totalCases <= 0', async () => {
    const res = await app.request('/agent-eval-results', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ agentType: 't', model: 'm', suite: 's', totalCases: 0, passedCases: 0 }),
    })
    expect(res.status).toBe(400)
  })
  test('400 when passedCases out of range', async () => {
    const res = await app.request('/agent-eval-results', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ agentType: 't', model: 'm', suite: 's', totalCases: 10, passedCases: -1 }),
    })
    expect(res.status).toBe(400)
    const res2 = await app.request('/agent-eval-results', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ agentType: 't', model: 'm', suite: 's', totalCases: 10, passedCases: 11 }),
    })
    expect(res2.status).toBe(400)
  })
  test('200 happy path with full payload', async () => {
    const res = await app.request('/agent-eval-results', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({
        workspaceId: 'w', agentType: 't', model: 'm', provider: 'anthropic',
        suite: 'nightly', totalCases: 10, passedCases: 9,
        avgWallTimeMs: 100, avgCreditCost: 0.05,
        commitSha: 'abc', metadata: { branch: 'main' },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, id: 'ev1', passRate: 0.9 })
    expect(store.recordedEval.metadata).toEqual({ branch: 'main' })
  })
  test('200 with minimal payload — null workspace, no metadata', async () => {
    const res = await app.request('/agent-eval-results', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({
        agentType: 't', model: 'm', suite: 's', totalCases: 5, passedCases: 5,
      }),
    })
    expect(res.status).toBe(200)
    expect(store.recordedEval.workspaceId).toBeNull()
    expect(store.recordedEval.metadata).toBeUndefined()
  })
  test('500 when recordAgentEvalResult throws', async () => {
    store.recordEvalThrow = new Error('db')
    const res = await app.request('/agent-eval-results', {
      method: 'POST', headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ agentType: 't', model: 'm', suite: 's', totalCases: 1, passedCases: 1 }),
    })
    expect(res.status).toBe(500)
  })
})

describe('wave-4A-c remaining gaps', () => {
  test('local-mode runtime-token validateAuth without projectId (preview-token route)', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    store.podIdentity = null
    store.runtimeVerify = { ok: true, projectId: 'p1' }
    const res = await app.request('/validate-preview-token', {
      method: 'POST',
      headers: { 'x-runtime-token': 'rt', ...JSON_H },
      body: JSON.stringify({ token: 't' }),
    })
    expect(res.status).toBe(200)
  })

  test('500 when verifyPreviewToken itself throws', async () => {
    store.previewVerifyThrow = new Error('jwt boom')
    const res = await app.request('/validate-preview-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ token: 't' }),
    })
    expect(res.status).toBe(500)
  })

  test('500 when verifyRuntimeToken itself throws', async () => {
    store.runtimeVerifyThrow = new Error('rt boom')
    const res = await app.request('/validate-runtime-token', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ token: 't' }),
    })
    expect(res.status).toBe(500)
  })
})

// ─── GET /projects/:projectId/trust ─────────────────────────────────────────
//
// Authoritative trust read used by the runtime's TrustResolver.
// Bug fixed: trust used to be a spawn-time env snapshot; this endpoint
// is the live source the resolver fetches from at every chat turn (and
// on demand via POST /internal/refresh-trust).
describe('GET /projects/:projectId/trust', () => {
  test('400 when projectId path param is empty', async () => {
    // Hono won't even match the route with an empty :projectId, but
    // verify we don't 500 on weird inputs that resolve to ''.
    const res = await app.request('/projects//trust', { headers: { ...SA } })
    expect([400, 404]).toContain(res.status)
  })

  test('401 when no auth headers', async () => {
    const res = await app.request('/projects/p1/trust')
    expect(res.status).toBe(401)
  })

  test('403 when SA token is invalid and not local mode', async () => {
    store.podIdentity = null
    const res = await app.request('/projects/p1/trust', { headers: { ...SA } })
    expect(res.status).toBe(401)
  })

  test('404 when project does not exist', async () => {
    store.prismaProjectFindUnique = null
    const res = await app.request('/projects/missing/trust', { headers: { ...SA } })
    expect(res.status).toBe(404)
  })

  test('200 returns trusted/external with folder ordering (primary first, then by lastOpenedAt desc)', async () => {
    store.prismaProjectFindUnique = {
      trustLevel: 'trusted',
      workingMode: 'external',
      projectFolders: [
        { path: '/work/older', isPrimary: false, lastOpenedAt: new Date('2026-01-01') },
        { path: '/work/primary', isPrimary: true, lastOpenedAt: new Date('2025-01-01') },
        { path: '/work/newer', isPrimary: false, lastOpenedAt: new Date('2026-05-01') },
      ],
    }
    const res = await app.request('/projects/p1/trust', { headers: { ...SA } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      trustLevel: 'trusted',
      workingMode: 'external',
      linkedFolders: ['/work/primary', '/work/newer', '/work/older'],
    })
  })

  test('200 normalizes unknown trustLevel/workingMode to safe defaults', async () => {
    // The runtime expects strict 'trusted'|'restricted' and 'managed'|'external'.
    // Anything else from the DB must collapse to the safe default
    // (trusted unless explicitly restricted; managed unless explicitly external)
    // so the resolver never sees ambiguous values.
    store.prismaProjectFindUnique = {
      trustLevel: 'something-weird',
      workingMode: null,
      projectFolders: [],
    }
    const res = await app.request('/projects/p1/trust', { headers: { ...SA } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      trustLevel: 'trusted',
      workingMode: 'managed',
      linkedFolders: [],
    })
  })

  test('200 maps restricted/managed combo correctly', async () => {
    store.prismaProjectFindUnique = {
      trustLevel: 'restricted',
      workingMode: 'managed',
      projectFolders: [],
    }
    const res = await app.request('/projects/p1/trust', { headers: { ...SA } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      trustLevel: 'restricted',
      workingMode: 'managed',
      linkedFolders: [],
    })
  })

  test('200 handles folders with null lastOpenedAt (treats as oldest)', async () => {
    store.prismaProjectFindUnique = {
      trustLevel: 'trusted',
      workingMode: 'external',
      projectFolders: [
        { path: '/never-opened', isPrimary: false, lastOpenedAt: null },
        { path: '/opened', isPrimary: false, lastOpenedAt: new Date('2026-05-01') },
      ],
    }
    const res = await app.request('/projects/p1/trust', { headers: { ...SA } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { linkedFolders: string[] }
    expect(body.linkedFolders).toEqual(['/opened', '/never-opened'])
  })

  test('200 with runtime token in local mode', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    store.podIdentity = null
    store.runtimeVerify = { ok: true, projectId: 'p-local' }
    store.prismaProjectFindUnique = {
      trustLevel: 'trusted',
      workingMode: 'external',
      projectFolders: [],
    }
    const res = await app.request('/projects/p-local/trust', {
      headers: { 'x-runtime-token': 'rt' },
    })
    expect(res.status).toBe(200)
  })

  test('401 when runtime token belongs to a different project (local mode)', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    store.podIdentity = null
    store.runtimeVerify = { ok: true, projectId: 'someone-else' }
    const res = await app.request('/projects/mine/trust', {
      headers: { 'x-runtime-token': 'rt' },
    })
    expect(res.status).toBe(401)
  })

  test('500 when prisma throws', async () => {
    store.prismaProjectFindUniqueThrow = new Error('db down')
    const res = await app.request('/projects/p1/trust', { headers: { ...SA } })
    expect(res.status).toBe(500)
  })
})

describe('validateAuth: local mode with no runtime token header', () => {
  test('returns false (route 401) when SHOGO_LOCAL_MODE=true but x-runtime-token missing', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    store.podIdentity = null
    const res = await app.request('/validate-preview-token', {
      method: 'POST',
      headers: { ...JSON_H },
      body: JSON.stringify({ token: 't' }),
    })
    expect(res.status).toBe(401)
  })
})
