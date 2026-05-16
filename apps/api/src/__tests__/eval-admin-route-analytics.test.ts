// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Coverage for the analytics + export endpoints in
 * `src/routes/eval-admin.ts` that the base suite skips because they
 * need a richer prisma mock (the base mock doesn't support
 * findMany({ include }) on evalRunResult without a where.runId).
 *
 * Endpoints covered:
 *   - GET  /analytics/overview               (lines 369-460)
 *   - GET  /analytics/eval-history/:evalId   (lines 465-505)
 *   - GET  /analytics/tool-usage             (lines 510-571)
 *   - GET  /analytics/model-comparison       (lines 576-628)
 *   - POST /export                           (lines 633-702)
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { userId: 'admin_1' }); await next() },
  requireAuth: async (_c: any, next: any) => next(),
}))
mock.module('../middleware/super-admin', () => ({
  requireSuperAdmin: async (_c: any, next: any) => next(),
}))
mock.module('@shogo/model-catalog', () => ({
  MODEL_CATALOG: { 'claude-sonnet-4-5': {}, 'gpt-4o': {} },
  MODEL_ALIASES: { sonnet: 'claude-sonnet-4-5' },
}))
mock.module('../lib/eval-job-manager', () => ({
  createEvalJob: async () => 'job',
  deleteEvalJob: async () => undefined,
  getEvalJobStatus: async () => 'running',
}))
mock.module('child_process', () => ({ spawn: () => ({}), execSync: () => '' }))

type Run = { id: string; track: string; model: string; status: string; startedAt: Date | null; createdAt: Date; summary?: any; cost?: any; byCategory?: any; results?: Result[] }
type Result = {
  runId: string; evalId: string; name: string; category: string; level: number;
  passed: boolean; score: number; maxScore: number; percentage: number;
  durationMs?: number | null; toolCallCount?: number | null; failedToolCalls?: any;
  iterations?: number | null; tokens?: any; phaseScores?: any; log?: string | null;
  criteria?: any; createdAt: Date;
}

let runs: Map<string, Run>
let results: Result[]

const prismaMock = {
  evalRun: {
    findMany: async (args: any) => {
      let list = Array.from(runs.values())
      if (args?.where?.status) list = list.filter((r) => r.status === args.where.status)
      if (args?.where?.track) list = list.filter((r) => r.track === args.where.track)
      if (args?.orderBy?.createdAt === 'desc') {
        list = list.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      }
      if (args?.include?.results) {
        list = list.map((r) => ({ ...r, results: results.filter((x) => x.runId === r.id) }))
      }
      return list
    },
    findFirst: async () => null,
    findUnique: async () => null,
    update: async (_a: any) => null,
    delete: async () => null,
  },
  evalRunResult: {
    findMany: async (args: any) => {
      let list = results
      if (args?.where?.evalId) list = list.filter((r) => r.evalId === args.where.evalId)
      if (args?.where?.runId?.in) list = list.filter((r) => args.where.runId.in.includes(r.runId))
      if (args?.where?.passed !== undefined) list = list.filter((r) => r.passed === args.where.passed)
      if (args?.include?.run) {
        list = list.map((r) => {
          const run = runs.get(r.runId)
          return { ...r, run: run ? {
            id: run.id, track: run.track, model: run.model, status: run.status,
            startedAt: run.startedAt, createdAt: run.createdAt,
          } : null }
        })
      }
      if (args?.where?.run?.status) {
        list = list.filter((r: any) => r.run?.status === args.where.run.status || (runs.get(r.runId)?.status === args.where.run.status))
      }
      if (args?.orderBy?.createdAt === 'asc') {
        list = list.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      }
      return list
    },
  },
}

mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

const { evalAdminRoutes } = await import('../routes/eval-admin')
const admin = evalAdminRoutes()

beforeEach(() => {
  runs = new Map()
  results = []
})

function seedRun(p: Partial<Run> = {}): Run {
  const run: Run = {
    id: `run_${runs.size + 1}`,
    track: 'agentic',
    model: 'sonnet',
    status: 'completed',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    summary: { total: 2, passed: 1, failed: 1, passRate: 50, avgScore: 2.5, totalPoints: 5, maxPoints: 10 },
    cost: { totalUsd: 0.42 },
    byCategory: { core: { passed: 1, total: 2 } },
    ...p,
  }
  runs.set(run.id, run)
  return run
}

function seedResult(p: Partial<Result> & { runId: string; evalId: string }): Result {
  const r: Result = {
    name: `eval-${p.evalId}`, category: 'core', level: 1,
    passed: true, score: 5, maxScore: 5, percentage: 100,
    durationMs: 1000, toolCallCount: 3, failedToolCalls: 0, iterations: 2,
    tokens: { input: 100, output: 50 }, phaseScores: null, log: null,
    criteria: null, createdAt: new Date('2026-01-01T00:00:00Z'),
    ...p,
  } as Result
  results.push(r)
  return r
}

// ─── /analytics/overview ───────────────────────────────────────────────

describe('GET /analytics/overview', () => {
  test('returns empty difficulty curve when no completed results exist', async () => {
    const res = await admin.fetch(new Request('http://t/analytics/overview'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data).toBeDefined()
  })

  test('aggregates pass rate by level + builds a category heatmap', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', level: 1, category: 'core', passed: true, percentage: 100 })
    seedResult({ runId: run.id, evalId: 'e2', level: 1, category: 'core', passed: false, percentage: 0 })
    seedResult({ runId: run.id, evalId: 'e3', level: 2, category: 'edge', passed: true, percentage: 100 })
    const res = await admin.fetch(new Request('http://t/analytics/overview'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.difficultyCurve).toBeDefined()
    // Level-1 should be 50% (1/2), level-2 100% (1/1)
    const lvl1 = body.data.difficultyCurve.find((c: any) => c.level === 1)
    expect(lvl1.passRate).toBe(50)
    const lvl2 = body.data.difficultyCurve.find((c: any) => c.level === 2)
    expect(lvl2.passRate).toBe(100)
    expect(body.data.heatmap.length).toBeGreaterThanOrEqual(2)
  })

  test('uses level=0 fallback when result.level is null/undefined', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', level: null as any, category: 'core', passed: true })
    const res = await admin.fetch(new Request('http://t/analytics/overview'))
    const body: any = await res.json()
    const lvl0 = body.data.difficultyCurve.find((c: any) => c.level === 0)
    expect(lvl0).toBeDefined()
  })

  test('only counts results from completed runs (in-progress runs ignored)', async () => {
    seedRun({ id: 'run_done', status: 'completed' })
    seedRun({ id: 'run_running', status: 'running' })
    seedResult({ runId: 'run_done', evalId: 'e1', level: 1, passed: true })
    seedResult({ runId: 'run_running', evalId: 'e2', level: 1, passed: false })
    const res = await admin.fetch(new Request('http://t/analytics/overview'))
    const body: any = await res.json()
    const lvl1 = body.data.difficultyCurve.find((c: any) => c.level === 1)
    // Only the completed run's result counts → 1/1 passed
    expect(lvl1.total).toBe(1)
    expect(lvl1.passed).toBe(1)
  })
})

// ─── /analytics/eval-history/:evalId ───────────────────────────────────

describe('GET /analytics/eval-history/:evalId', () => {
  test('empty history → { history: [] }', async () => {
    const res = await admin.fetch(new Request('http://t/analytics/eval-history/never-seen'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.evalId).toBe('never-seen')
    expect(body.data.history).toEqual([])
  })

  test('history echoes metadata from the first completed result + maps every entry', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'eA', name: 'evalA', category: 'core', level: 2, maxScore: 10, passed: true, score: 8, percentage: 80 })
    const res = await admin.fetch(new Request('http://t/analytics/eval-history/eA'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.name).toBe('evalA')
    expect(body.data.category).toBe('core')
    expect(body.data.level).toBe(2)
    expect(body.data.maxScore).toBe(10)
    expect(body.data.history.length).toBe(1)
    expect(body.data.history[0].track).toBe('agentic')
    expect(body.data.history[0].percentage).toBe(80)
  })

  test('history skips results from non-completed runs', async () => {
    seedRun({ id: 'run_done', status: 'completed' })
    seedRun({ id: 'run_running', status: 'running' })
    seedResult({ runId: 'run_done', evalId: 'eShared', passed: true })
    seedResult({ runId: 'run_running', evalId: 'eShared', passed: false })
    const res = await admin.fetch(new Request('http://t/analytics/eval-history/eShared'))
    const body: any = await res.json()
    expect(body.data.history.length).toBe(1)
  })
})

// ─── /analytics/tool-usage ─────────────────────────────────────────────

describe('GET /analytics/tool-usage', () => {
  test('200 with empty stats when no results exist', async () => {
    const res = await admin.fetch(new Request('http://t/analytics/tool-usage'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data).toBeDefined()
  })

  test('200 with tool counts when results have toolCallCount', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', toolCallCount: 4, failedToolCalls: 1, passed: true })
    seedResult({ runId: run.id, evalId: 'e2', toolCallCount: 0, failedToolCalls: 0, passed: false })
    const res = await admin.fetch(new Request('http://t/analytics/tool-usage'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.ok).toBe(true)
  })
})

// ─── /analytics/model-comparison ───────────────────────────────────────

describe('GET /analytics/model-comparison', () => {
  test('returns empty models when no completed runs exist', async () => {
    const res = await admin.fetch(new Request('http://t/analytics/model-comparison'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.models).toEqual([])
    expect(body.data.comparison).toEqual([])
    expect(body.data.availableTracks).toEqual([])
  })

  test('keeps only the most recent run per model + builds comparison matrix', async () => {
    const newer = seedRun({ id: 'r_new', model: 'sonnet', createdAt: new Date('2026-03-01') })
    seedRun({ id: 'r_old', model: 'sonnet', createdAt: new Date('2026-01-01') })
    seedRun({ id: 'r_other', model: 'gpt-4o', createdAt: new Date('2026-02-01') })
    seedResult({ runId: newer.id, evalId: 'e1', passed: true, score: 5, maxScore: 5, percentage: 100 })
    seedResult({ runId: 'r_other', evalId: 'e1', passed: false, score: 0, maxScore: 5, percentage: 0 })
    const res = await admin.fetch(new Request('http://t/analytics/model-comparison'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.models.length).toBe(2)
    const sonnet = body.data.models.find((m: any) => m.model === 'sonnet')
    expect(sonnet.runId).toBe('r_new') // most recent wins
    expect(body.data.comparison.length).toBe(1)
    expect(body.data.comparison[0].evalId).toBe('e1')
  })

  test('filters by track when ?track= query is supplied', async () => {
    seedRun({ id: 'r_agentic', model: 'sonnet', track: 'agentic' })
    seedRun({ id: 'r_classic', model: 'gpt-4o', track: 'classic' })
    const res = await admin.fetch(new Request('http://t/analytics/model-comparison?track=agentic'))
    const body: any = await res.json()
    expect(body.data.models.length).toBe(1)
    expect(body.data.models[0].model).toBe('sonnet')
  })

  test('uses defaults when run.summary / cost / byCategory are null', async () => {
    const r = seedRun({ id: 'r_nosum', summary: null, cost: null, byCategory: null })
    seedResult({ runId: r.id, evalId: 'e1', passed: true })
    const res = await admin.fetch(new Request('http://t/analytics/model-comparison'))
    const body: any = await res.json()
    const m = body.data.models[0]
    expect(m.summary.total).toBe(0)
    expect(m.byCategory).toEqual({})
  })
})

// ─── POST /export ─────────────────────────────────────────────────────

describe('POST /export', () => {
  test('jsonl format returns NDJSON body with newline-separated records', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', passed: true, percentage: 95, log: '## Agent Response\nHello world\n## Tool Calls\nfoo()' })
    seedResult({ runId: run.id, evalId: 'e2', passed: false, percentage: 0 })
    const res = await admin.fetch(new Request('http://t/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.id], format: 'jsonl' }),
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    const text = await res.text()
    const lines = text.split('\n')
    expect(lines.length).toBe(2)
    const first = JSON.parse(lines[0])
    expect(first.evalId).toBe('e1')
    expect(first.responseText).toBe('Hello world')
    expect(first.quality).toBe('good') // 95% passed → good
  })

  test('json format returns { ok, data: [...] }', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', passed: true, percentage: 95 })
    const res = await admin.fetch(new Request('http://t/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.id], format: 'json' }),
    }))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.length).toBe(1)
    expect(body.data[0].quality).toBe('good')
  })

  test('quality is "bad" for failed results regardless of percentage', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', passed: false, percentage: 99 })
    const res = await admin.fetch(new Request('http://t/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.id], format: 'json' }),
    }))
    const body: any = await res.json()
    expect(body.data[0].quality).toBe('bad')
  })

  test('quality is "needs_improvement" for passing results with percentage < 90', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', passed: true, percentage: 75 })
    const res = await admin.fetch(new Request('http://t/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.id], format: 'json' }),
    }))
    const body: any = await res.json()
    expect(body.data[0].quality).toBe('needs_improvement')
  })

  test('filter=passing only includes passed results', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', passed: true })
    seedResult({ runId: run.id, evalId: 'e2', passed: false })
    const res = await admin.fetch(new Request('http://t/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.id], filter: 'passing', format: 'json' }),
    }))
    const body: any = await res.json()
    expect(body.data.length).toBe(1)
    expect(body.data[0].evalId).toBe('e1')
  })

  test('filter=failing only includes failed results', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', passed: true })
    seedResult({ runId: run.id, evalId: 'e2', passed: false })
    const res = await admin.fetch(new Request('http://t/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.id], filter: 'failing', format: 'json' }),
    }))
    const body: any = await res.json()
    expect(body.data.length).toBe(1)
    expect(body.data[0].evalId).toBe('e2')
  })

  test('default format=jsonl when no format specified', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', passed: true })
    const res = await admin.fetch(new Request('http://t/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.id] }),
    }))
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
  })

  test('intentExecutionGap is computed when phaseScores has both intent + exec', async () => {
    const run = seedRun()
    seedResult({
      runId: run.id, evalId: 'e1', passed: true, percentage: 95,
      phaseScores: { intention: { percentage: 90 }, execution: { percentage: 70 } },
    })
    const res = await admin.fetch(new Request('http://t/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.id], format: 'json' }),
    }))
    const body: any = await res.json()
    expect(body.data[0].intentExecutionGap).toBe(20)
  })

  test('intentExecutionGap is null when phaseScores is missing', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'e1', passed: true, phaseScores: null })
    const res = await admin.fetch(new Request('http://t/export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.id], format: 'json' }),
    }))
    const body: any = await res.json()
    expect(body.data[0].intentExecutionGap).toBeNull()
  })
})
