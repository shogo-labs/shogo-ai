// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/eval-admin.ts` — super-admin eval pipeline routes.
 *
 * Two routers exported:
 *   - evalAdminRoutes()    — admin-only CRUD + trigger/cancel
 *   - evalInternalRoutes() — callback endpoints secured by EVAL_CALLBACK_SECRET
 *
 * Covers (focus on high-value branches):
 *   - GET /runs                        — basic listing + mapping
 *   - GET /runs/active                  — no run, dead-process auto-fail (local),
 *                                          k8s-done synthesis, progress-array variant,
 *                                          progress-object variant with workers
 *   - GET /runs/:id                     — 404 missing, happy
 *   - POST /runs/trigger                — 409 already running, 400 invalid track,
 *                                          400 invalid model, local spawn happy,
 *                                          K8s Job happy, K8s Job create failure
 *   - POST /runs/:id/cancel             — 404 (not running), local kill, K8s delete
 *   - PATCH /runs/:id                   — 404, 400 invalid tags, 400 empty body,
 *                                          label set/clear, tag string-filter
 *   - DELETE /runs/:id                  — 404, 409 running, happy
 *   - Internal: progress/result/complete/fail — 401 bad secret + happy paths
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'

// ─── Auth + super-admin middleware: pass-through ──────────────────────

mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { userId: 'admin_1' }); await next() },
  requireAuth: async (_c: any, next: any) => next(),
}))
mock.module('../middleware/super-admin', () => ({
  requireSuperAdmin: async (_c: any, next: any) => next(),
}))

// ─── Model catalog mock (so VALID_MODELS isn't empty) ─────────────────

mock.module('@shogo/model-catalog', () => ({
  MODEL_CATALOG: { 'claude-sonnet-4-5': {}, 'gpt-4o': {} },
  MODEL_ALIASES: { sonnet: 'claude-sonnet-4-5', haiku: 'claude-haiku-4-5' },
}))

// ─── eval-job-manager mock ────────────────────────────────────────────

const evalJobMgr = {
  createEvalJob: mock(async (_args: any) => 'job-name'),
  deleteEvalJob: mock(async (_name: string) => undefined),
  getEvalJobStatus: mock(async (_name: string) => 'running' as 'running' | 'succeeded' | 'failed'),
}
mock.module('../lib/eval-job-manager', () => evalJobMgr)

// ─── child_process spawn mock ────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 12345
  unref = mock(() => {})
}
let lastSpawn: FakeChild | null = null
const spawnSpy = mock((..._args: any[]) => { lastSpawn = new FakeChild(); return lastSpawn as any })
mock.module('child_process', () => ({ spawn: spawnSpy, execSync: () => '' }))

// ─── Prisma mock ──────────────────────────────────────────────────────

let runs: Map<string, any>
let results: any[]
let nextId = 1

function makeRun(p: Partial<any> = {}): any {
  return {
    id: `run_${nextId++}`,
    track: 'agentic',
    model: 'sonnet',
    workers: 1,
    status: 'completed',
    pid: null,
    jobName: null,
    triggeredBy: 'admin_1',
    label: null,
    tags: [],
    summary: null,
    cost: null,
    byCategory: null,
    resources: null,
    progress: null,
    error: null,
    startedAt: new Date('2026-01-01'),
    completedAt: new Date('2026-01-01T01:00:00Z'),
    createdAt: new Date('2026-01-01'),
    ...p,
  }
}

const prismaMock = {
  evalRun: {
    findMany: async (args: any) => {
      let rows = Array.from(runs.values())
      if (args?.orderBy?.createdAt === 'desc') {
        rows = rows.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      }
      if (args?.take) rows = rows.slice(0, args.take)
      return rows
    },
    findFirst: async ({ where }: any) => {
      for (const r of runs.values()) {
        if (where?.status && r.status !== where.status) continue
        return r
      }
      return null
    },
    findUnique: async ({ where, include }: any) => {
      const row = runs.get(where.id)
      if (!row) return null
      if (include?.results) {
        return { ...row, results: results.filter((r) => r.runId === row.id) }
      }
      return row
    },
    create: async ({ data }: any) => {
      const r = makeRun({ ...data, id: `run_${nextId++}`, createdAt: new Date() })
      runs.set(r.id, r)
      return r
    },
    update: async ({ where, data }: any) => {
      const r = runs.get(where.id)
      if (!r) throw new Error('not found')
      Object.assign(r, data)
      return r
    },
    delete: async ({ where }: any) => {
      const r = runs.get(where.id)
      runs.delete(where.id)
      return r
    },
  },
  evalRunResult: {
    findFirst: async ({ where, select: _select }: any) => {
      const hit = results.find((r) => r.runId === where.runId && r.evalId === where.evalId)
      return hit ? { log: hit.log ?? null } : null
    },
    findMany: async ({ where }: any) => results.filter((r) => r.runId === where.runId),
    create: async ({ data }: any) => { results.push(data); return data },
    deleteMany: async ({ where }: any) => {
      const before = results.length
      results = results.filter((r) => r.runId !== where.runId)
      return { count: before - results.length }
    },
  },
}

mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

// ─── Import after mocks ──────────────────────────────────────────────

const { evalAdminRoutes, evalInternalRoutes } = await import('../routes/eval-admin')
const admin = evalAdminRoutes()
const internal = evalInternalRoutes()

// ─── Env reset ────────────────────────────────────────────────────────

const ORIG_K8S = process.env.KUBERNETES_SERVICE_HOST
const ORIG_SECRET = process.env.EVAL_CALLBACK_SECRET

beforeEach(() => {
  runs = new Map()
  results = []
  nextId = 1
  spawnSpy.mockClear()
  lastSpawn = null
  evalJobMgr.createEvalJob.mockClear()
  evalJobMgr.deleteEvalJob.mockClear()
  evalJobMgr.getEvalJobStatus.mockClear()
  evalJobMgr.createEvalJob.mockImplementation(async () => 'job-name')
  evalJobMgr.getEvalJobStatus.mockImplementation(async () => 'running')
  delete process.env.KUBERNETES_SERVICE_HOST
  process.env.EVAL_CALLBACK_SECRET = 'test-secret'
})

afterEach(() => {
  if (ORIG_K8S === undefined) delete process.env.KUBERNETES_SERVICE_HOST
  else process.env.KUBERNETES_SERVICE_HOST = ORIG_K8S
  if (ORIG_SECRET === undefined) delete process.env.EVAL_CALLBACK_SECRET
  else process.env.EVAL_CALLBACK_SECRET = ORIG_SECRET
})

// ═══════════════════════════════════════════════════════════════════════
// GET /runs
// ═══════════════════════════════════════════════════════════════════════

describe('GET /runs', () => {
  test('returns empty list', async () => {
    const res = await admin.request('/runs')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.runs).toEqual([])
  })

  test('returns runs ordered by createdAt desc, max 100', async () => {
    runs.set('a', makeRun({ id: 'a', createdAt: new Date('2026-01-01') }))
    runs.set('b', makeRun({ id: 'b', createdAt: new Date('2026-02-01') }))
    const body = await (await admin.request('/runs')).json()
    expect(body.data.runs[0].id).toBe('b')
    expect(body.data.runs[1].id).toBe('a')
  })

  test('maps key fields including dirName alias and tags fallback', async () => {
    runs.set('x', makeRun({ id: 'x', tags: null, label: 'nightly' }))
    const body = await (await admin.request('/runs')).json()
    expect(body.data.runs[0].dirName).toBe('x')
    expect(body.data.runs[0].tags).toEqual([])
    expect(body.data.runs[0].label).toBe('nightly')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// GET /runs/active
// ═══════════════════════════════════════════════════════════════════════

describe('GET /runs/active', () => {
  test('running:false when no active run', async () => {
    const body = await (await admin.request('/runs/active')).json()
    expect(body.data.running).toBe(false)
  })

  test('auto-fails local run when its pid is dead', async () => {
    const r = makeRun({ status: 'running', pid: 9_999_999 })
    runs.set(r.id, r)
    const body = await (await admin.request('/runs/active')).json()
    expect(body.data.running).toBe(false)
    expect(runs.get(r.id).status).toBe('failed')
    expect(runs.get(r.id).error).toMatch(/exited unexpectedly/)
  })

  test('k8s done branch synthesizes completion', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    const r = makeRun({ status: 'running', jobName: 'job-x', pid: null })
    runs.set(r.id, r)
    evalJobMgr.getEvalJobStatus.mockImplementation(async () => 'succeeded')
    results.push({ runId: r.id, passed: true, score: 5, maxScore: 5, percentage: 100, category: 'core' })
    results.push({ runId: r.id, passed: false, score: 0, maxScore: 5, percentage: 0, category: 'core' })

    const body = await (await admin.request('/runs/active')).json()
    expect(body.data.running).toBe(false)
    expect(runs.get(r.id).status).toBe('completed')
    expect((runs.get(r.id).summary as any).total).toBe(2)
    expect((runs.get(r.id).summary as any).passed).toBe(1)
  })

  test('progress as array maps to results aggregate', async () => {
    const r = makeRun({
      status: 'running', pid: process.pid, // current process => alive
      progress: [
        { id: 'e1', score: 1, max: 1, passed: true },
        { id: 'e2', score: 0, max: 1, passed: false },
      ],
    })
    runs.set(r.id, r)
    const body = await (await admin.request('/runs/active')).json()
    expect(body.data.running).toBe(true)
    expect(body.data.completed).toBe(2)
    expect(body.data.passed).toBe(1)
    expect(body.data.failed).toBe(1)
  })

  test('progress as object preserves workers + queueRemaining', async () => {
    const r = makeRun({
      status: 'running', pid: process.pid,
      progress: {
        results: [{ id: 'e1', score: 1, max: 1, passed: true }],
        totalEvals: 10,
        queueRemaining: 8,
        workers: [{ workerId: 1, status: 'idle' }],
      },
    })
    runs.set(r.id, r)
    const body = await (await admin.request('/runs/active')).json()
    expect(body.data.totalEvals).toBe(10)
    expect(body.data.queueRemaining).toBe(8)
    expect(body.data.workerStatus).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// GET /runs/:id
// ═══════════════════════════════════════════════════════════════════════

describe('GET /runs/:id', () => {
  test('404 when not found', async () => {
    const res = await admin.request('/runs/missing')
    expect(res.status).toBe(404)
  })

  test('happy path includes results', async () => {
    const r = makeRun({ id: 'r1' })
    runs.set(r.id, r)
    results.push({
      runId: 'r1', evalId: 'e1', name: 'eval one', category: 'core',
      passed: true, score: 5, maxScore: 5, percentage: 100, durationMs: 100,
    })
    const res = await admin.request('/runs/r1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dirName).toBe('r1')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /runs/trigger
// ═══════════════════════════════════════════════════════════════════════

describe('POST /runs/trigger', () => {
  function trigger(body: any) {
    return admin.request('/runs/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('409 when a run is already running', async () => {
    const existing = makeRun({ status: 'running' })
    runs.set(existing.id, existing)
    const res = await trigger({ track: 'agentic', model: 'sonnet' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.id).toBe(existing.id)
  })

  test('400 invalid track', async () => {
    const res = await trigger({ track: 'NOT_A_TRACK', model: 'sonnet' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Invalid track/)
  })

  test('400 invalid model', async () => {
    const res = await trigger({ track: 'agentic', model: 'NOPE' })
    expect(res.status).toBe(400)
  })

  test('spawns local process when not in K8s', async () => {
    const res = await trigger({ track: 'agentic', model: 'sonnet', workers: 4 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.started).toBe(true)
    expect(body.data.pid).toBe(12345)
    expect(body.data.workers).toBe(4)
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const args = spawnSpy.mock.calls[0][1]
    expect(args).toContain('--track')
    expect(args).toContain('agentic')
  })

  test('clamps workers to [1, 8]', async () => {
    const res = await trigger({ track: 'agentic', model: 'sonnet', workers: 999 })
    expect((await res.json()).data.workers).toBe(8)
  })

  test('workers default to 1 when omitted', async () => {
    const res = await trigger({ track: 'agentic', model: 'sonnet' })
    expect((await res.json()).data.workers).toBe(1)
  })

  test('K8s path creates Job and stores jobName', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    evalJobMgr.createEvalJob.mockImplementation(async () => 'job-abc')
    const res = await trigger({ track: 'agentic', model: 'sonnet' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.jobName).toBe('job-abc')
    expect(body.data.local).toBe(false)
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  test('K8s job creation failure marks run failed and returns 500', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    evalJobMgr.createEvalJob.mockImplementation(async () => { throw new Error('quota exceeded') })
    const res = await trigger({ track: 'agentic', model: 'sonnet' })
    expect(res.status).toBe(500)
    const all = Array.from(runs.values())
    expect(all[0].status).toBe('failed')
    expect(all[0].error).toMatch(/quota exceeded/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /runs/:id/cancel
// ═══════════════════════════════════════════════════════════════════════

describe('POST /runs/:id/cancel', () => {
  test('404 when run not found', async () => {
    const res = await admin.request('/runs/missing/cancel', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('404 when run is not running', async () => {
    const r = makeRun({ status: 'completed' })
    runs.set(r.id, r)
    const res = await admin.request(`/runs/${r.id}/cancel`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('cancels local running run (best-effort kill)', async () => {
    const r = makeRun({ status: 'running', pid: 999_999 })
    runs.set(r.id, r)
    const res = await admin.request(`/runs/${r.id}/cancel`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(runs.get(r.id).status).toBe('cancelled')
  })

  test('cancels K8s job via deleteEvalJob', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    const r = makeRun({ status: 'running', jobName: 'job-1', pid: null })
    runs.set(r.id, r)
    await admin.request(`/runs/${r.id}/cancel`, { method: 'POST' })
    expect(evalJobMgr.deleteEvalJob).toHaveBeenCalledWith('job-1')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// PATCH /runs/:id
// ═══════════════════════════════════════════════════════════════════════

describe('PATCH /runs/:id', () => {
  function patch(id: string, body: any) {
    return admin.request(`/runs/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('404 when run missing', async () => {
    const res = await patch('missing', { label: 'x' })
    expect(res.status).toBe(404)
  })

  test('400 empty body (no fields to update)', async () => {
    const r = makeRun()
    runs.set(r.id, r)
    const res = await patch(r.id, {})
    expect(res.status).toBe(400)
  })

  test('400 when tags is not an array', async () => {
    const r = makeRun()
    runs.set(r.id, r)
    const res = await patch(r.id, { tags: 'oops' })
    expect(res.status).toBe(400)
  })

  test('updates label', async () => {
    const r = makeRun()
    runs.set(r.id, r)
    const res = await patch(r.id, { label: 'new-label' })
    expect(res.status).toBe(200)
    expect(runs.get(r.id).label).toBe('new-label')
  })

  test('clears label when set to null', async () => {
    const r = makeRun({ label: 'old' })
    runs.set(r.id, r)
    await patch(r.id, { label: null })
    expect(runs.get(r.id).label).toBe(null)
  })

  test('filters out non-string tags', async () => {
    const r = makeRun()
    runs.set(r.id, r)
    await patch(r.id, { tags: ['ok', 123 as any, '', 'fine'] })
    expect(runs.get(r.id).tags).toEqual(['ok', 'fine'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DELETE /runs/:id
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /runs/:id', () => {
  test('404 when missing', async () => {
    const res = await admin.request('/runs/missing', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('409 when run is running', async () => {
    const r = makeRun({ status: 'running' })
    runs.set(r.id, r)
    const res = await admin.request(`/runs/${r.id}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
  })

  test('409 when run is pending', async () => {
    const r = makeRun({ status: 'pending' })
    runs.set(r.id, r)
    const res = await admin.request(`/runs/${r.id}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
  })

  test('deletes completed run', async () => {
    const r = makeRun({ status: 'completed' })
    runs.set(r.id, r)
    const res = await admin.request(`/runs/${r.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(runs.has(r.id)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Internal callbacks
// ═══════════════════════════════════════════════════════════════════════

describe('evalInternalRoutes()', () => {
  function authedReq(path: string, body: any, secret = 'test-secret') {
    return internal.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
    })
  }

  test('POST /evals/:id/progress 401 on bad secret', async () => {
    const res = await authedReq('/evals/run_1/progress', { results: [] }, 'wrong')
    expect(res.status).toBe(401)
  })

  test('POST /evals/:id/progress stores progress array directly', async () => {
    const r = makeRun({ id: 'rp', status: 'running' })
    runs.set(r.id, r)
    const res = await authedReq('/evals/rp/progress', {
      results: [{ id: 'e1', score: 1, max: 1, passed: true }],
    })
    expect(res.status).toBe(200)
    expect(Array.isArray(runs.get('rp').progress)).toBe(true)
  })

  test('POST /evals/:id/progress stores object form when workers present', async () => {
    const r = makeRun({ id: 'rp2', status: 'running' })
    runs.set(r.id, r)
    await authedReq('/evals/rp2/progress', {
      results: [], workers: [{ workerId: 1, status: 'idle' }], totalEvals: 5,
    })
    const p = runs.get('rp2').progress
    expect(p.workers).toHaveLength(1)
    expect(p.totalEvals).toBe(5)
  })

  test('POST /evals/:id/result 401 on bad secret', async () => {
    const res = await authedReq('/evals/r/result', { result: {} }, 'wrong')
    expect(res.status).toBe(401)
  })

  test('POST /evals/:id/result persists row', async () => {
    const r = makeRun({ id: 'rr', status: 'running' })
    runs.set(r.id, r)
    await authedReq('/evals/rr/result', {
      result: {
        eval: { id: 'e1', name: 'eval one', category: 'core', level: 1 },
        passed: true, score: 5, maxScore: 5, percentage: 100,
        timing: { startTime: 0, endTime: 100, durationMs: 100 },
        metrics: { tokens: { input: 10, output: 5 }, toolCallCount: 2, failedToolCalls: 0, iterations: 1 },
        phaseScores: null, criteriaResults: [], triggeredAntiPatterns: [],
      },
      log: 'some log',
    })
    expect(results).toHaveLength(1)
    expect(results[0].evalId).toBe('e1')
    expect(results[0].log).toBe('some log')
  })

  test('POST /evals/:id/complete 401 on bad secret', async () => {
    const res = await authedReq('/evals/r/complete', { suite: {}, logs: {} }, 'wrong')
    expect(res.status).toBe(401)
  })

  test('POST /evals/:id/complete sets status=completed and stores results', async () => {
    const r = makeRun({ id: 'rc', status: 'running' })
    runs.set(r.id, r)
    await authedReq('/evals/rc/complete', {
      suite: {
        name: 'agentic',
        model: 'sonnet',
        timestamp: new Date().toISOString(),
        summary: { total: 1, passed: 1, failed: 0 },
        cost: { totalCost: 1.5 },
        byCategory: {},
        results: [{
          eval: { id: 'e1', name: 'eval1', category: 'core' },
          passed: true, score: 1, maxScore: 1, percentage: 100,
          timing: { durationMs: 50 },
          metrics: { tokens: null, toolCallCount: 0, failedToolCalls: 0, iterations: 0 },
        }],
      },
      logs: { e1: 'log content' },
    })
    expect(runs.get('rc').status).toBe('completed')
    expect(runs.get('rc').summary.total).toBe(1)
    expect(results).toHaveLength(1)
    expect(results[0].log).toBe('log content')
  })

  test('POST /evals/:id/fail marks failed and stores error', async () => {
    const r = makeRun({ id: 'rf', status: 'running' })
    runs.set(r.id, r)
    await authedReq('/evals/rf/fail', { error: 'crashed' })
    expect(runs.get('rf').status).toBe('failed')
    expect(runs.get('rf').error).toBe('crashed')
  })

  test('POST /evals/:id/fail 401 on bad secret', async () => {
    const res = await authedReq('/evals/r/fail', { error: 'x' }, 'wrong')
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// gap-closing: phase-3 holdouts in eval-admin.ts
// ═══════════════════════════════════════════════════════════════════════

describe('GET /runs/:id/log/:evalId (L348-360)', () => {
  test('404 when no result row matches', async () => {
    runs.set('r1', makeRun({ id: 'r1' }))
    const res = await admin.request('/runs/r1/log/eval_x')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/Log not found/)
  })

  test('404 when result exists but log field is null', async () => {
    runs.set('r1', makeRun({ id: 'r1' }))
    results.push({ runId: 'r1', evalId: 'eval_x', log: null })
    const res = await admin.request('/runs/r1/log/eval_x')
    expect(res.status).toBe(404)
  })

  test('200 returns log content when present', async () => {
    runs.set('r1', makeRun({ id: 'r1' }))
    results.push({ runId: 'r1', evalId: 'eval_x', log: 'hello log' })
    const res = await admin.request('/runs/r1/log/eval_x')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ evalId: 'eval_x', content: 'hello log' })
  })
})

describe('GET /runs/:id — K8s-done synthesis + isRunning summary (L305-313, L324-330)', () => {
  test('synthesizes completion when isKubernetes and getEvalJobStatus says succeeded (L306-313)', async () => {
    process.env.KUBERNETES_SERVICE_HOST = 'k8s'
    const r = makeRun({ id: 'rk', status: 'running', jobName: 'job-rk' })
    runs.set(r.id, r)
    // Seed at least one result so synthesizeCompletionFromResults has data.
    results.push({
      runId: r.id, evalId: 'e1', score: 1, maxScore: 1, passed: true,
      durationMs: 10, category: 'core', name: 'e1', tokens: null,
      toolCallCount: 0, failedToolCalls: 0, iterations: 0, log: null,
    })
    evalJobMgr.getEvalJobStatus.mockImplementation(async () => 'succeeded')
    const res = await admin.request(`/runs/${r.id}`)
    expect(res.status).toBe(200)
  })

  test('synthesizes summary from progress array on a still-running run (L324-330)', async () => {
    const r = makeRun({
      id: 'rp', status: 'running',
      progress: [
        { passed: true,  score: 3, max: 5 },
        { passed: false, score: 1, max: 5 },
        { passed: true,  score: 5, max: 5 },
      ],
      summary: null,
    })
    runs.set(r.id, r)
    const res = await admin.request(`/runs/${r.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.summary.total).toBe(3)
    expect(body.data.summary.passed).toBe(2)
    expect(body.data.summary.failed).toBe(1)
    expect(body.data.summary.totalPoints).toBe(9)
    expect(body.data.summary.maxPoints).toBe(15)
  })
})

describe('isK8sJobDone catch arm (L61-62)', () => {
  test('returns "running" when getEvalJobStatus throws', async () => {
    process.env.KUBERNETES_SERVICE_HOST = 'k8s'
    const r = makeRun({ id: 'rt', status: 'running', jobName: 'job-rt' })
    runs.set(r.id, r)
    evalJobMgr.getEvalJobStatus.mockImplementation(async () => {
      throw new Error('k8s api offline')
    })
    // The /runs/:id endpoint calls isK8sJobDone -> getEvalJobStatus throws
    // -> isK8sJobDone catches -> returns 'running' -> the if at L305 is false
    // -> no synthesis. Net effect: 200 with status still running.
    const res = await admin.request(`/runs/${r.id}`)
    expect(res.status).toBe(200)
    expect((await res.json()).data.status).toBe('running')
  })
})

describe('POST /runs/trigger — child stdout/stderr/error/exit handlers (L803-816)', () => {
  test('local spawn handlers swallow stdout/stderr lines + exit codes', async () => {
    const origLog = console.log
    const origErr = console.error
    const logs: any[][] = []
    const errs: any[][] = []
    console.log = (...a: any[]) => { logs.push(a) }
    console.error = (...a: any[]) => { errs.push(a) }
    try {
      const res = await admin.request('/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ track: 'agentic', model: 'sonnet' }),
      })
      expect(res.status).toBe(200)
      const child = lastSpawn!
      child.stdout.emit('data', Buffer.from('line1\nline2\n'))
      child.stderr.emit('data', Buffer.from('errA\nerrB\n'))
      child.emit('error', new Error('spawn ENOENT'))
      child.emit('exit', 1, null)
      child.emit('exit', 0, null)
      expect(logs.some((a) => String(a[0]).includes('line1'))).toBe(true)
      expect(errs.some((a) => String(a[0]).includes('errA'))).toBe(true)
      expect(errs.some((a) => String(a[0]).includes('Failed to spawn'))).toBe(true)
      expect(errs.some((a) => String(a[0]).includes('Eval process exited: code=1'))).toBe(true)
    } finally {
      console.log = origLog
      console.error = origErr
    }
  })
})

describe('criteriaResults map arrow (L1005-1011, L1066-1071) + result-create catch (L1018-1020)', () => {
  function authedReq(path: string, body: any, secret = 'test-secret') {
    return internal.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    })
  }

  test('/evals/:id/result maps non-empty criteriaResults (closes L1005-1011)', async () => {
    runs.set('rcm', makeRun({ id: 'rcm', status: 'running' }))
    await authedReq('/evals/rcm/result', {
      result: {
        eval: { id: 'e_crit', name: 'crit', category: 'core', level: 1 },
        passed: true, score: 2, maxScore: 2, percentage: 100,
        timing: { startTime: 0, endTime: 50, durationMs: 50 },
        metrics: { tokens: null, toolCallCount: 0, failedToolCalls: 0, iterations: 0 },
        phaseScores: null,
        criteriaResults: [
          { criterion: { description: 'A', phase: 'p1', points: 1 }, pointsEarned: 1, passed: true },
          { criterion: { description: 'B', phase: 'p2', points: 1 }, pointsEarned: 0, passed: false },
        ],
        triggeredAntiPatterns: [],
      },
      log: 'l',
    })
    expect(results).toHaveLength(1)
    expect(results[0].criteria).toHaveLength(2)
    expect(results[0].criteria[0]).toEqual({ description: 'A', phase: 'p1', points: 1, pointsEarned: 1, passed: true })
    expect(results[0].criteria[1].pointsEarned).toBe(0)
  })

  test('/evals/:id/result catches prisma create failure (closes L1018-1020)', async () => {
    runs.set('rcf', makeRun({ id: 'rcf', status: 'running' }))
    const origErr = console.error
    const errs: any[][] = []
    console.error = (...a: any[]) => { errs.push(a) }
    const origCreate = prismaMock.evalRunResult.create
    prismaMock.evalRunResult.create = (async () => { throw new Error('db boom') }) as any
    try {
      const res = await authedReq('/evals/rcf/result', {
        result: {
          eval: { id: 'e_boom', name: 'b', category: 'core', level: 1 },
          passed: false, score: 0, maxScore: 1, percentage: 0,
          timing: { startTime: 0, endTime: 1, durationMs: 1 },
          metrics: { tokens: null, toolCallCount: 0, failedToolCalls: 0, iterations: 0 },
          phaseScores: null, criteriaResults: [], triggeredAntiPatterns: [],
        },
        log: null,
      })
      expect(res.status).toBe(200)
      expect(errs.some((a) => String(a[0]).includes('Failed to create result for e_boom'))).toBe(true)
    } finally {
      prismaMock.evalRunResult.create = origCreate
      console.error = origErr
    }
  })

  test('/evals/:id/complete maps non-empty criteriaResults inside results array (closes L1066-1071)', async () => {
    runs.set('rcc', makeRun({ id: 'rcc', status: 'running' }))
    await authedReq('/evals/rcc/complete', {
      suite: {
        name: 'agentic', model: 'sonnet', timestamp: new Date().toISOString(),
        summary: { total: 1, passed: 1, failed: 0 },
        cost: { totalCost: 0.1 },
        byCategory: {},
        results: [{
          eval: { id: 'e_crit2', name: 'c', category: 'core' },
          passed: true, score: 1, maxScore: 1, percentage: 100,
          timing: { durationMs: 10 },
          metrics: { tokens: null, toolCallCount: 0, failedToolCalls: 0, iterations: 0 },
          phaseScores: null,
          criteriaResults: [
            { criterion: { description: 'X', phase: 'p', points: 2 }, pointsEarned: 2, passed: true },
          ],
          triggeredAntiPatterns: [],
        }],
      },
      logs: { e_crit2: 'log here' },
    })
    expect(results).toHaveLength(1)
    expect(results[0].criteria).toEqual([
      { description: 'X', phase: 'p', points: 2, pointsEarned: 2, passed: true },
    ])
  })
})
