// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage gap-fillers for analytics endpoints in src/routes/eval-admin.ts:
//   - GET /analytics/overview phaseScores → intentionVsExecution aggregation (lines 414-432)
//   - GET /analytics/overview pipeline + pipelinePhase pass-rate aggregation (lines 434-449)
//   - GET /analytics/tool-usage log-regex parsing: counts + ERROR matches + passing/failing correlation (lines 524-566)
//   - GET /runs/:id dead-process detection branch (lines 273-303)
//   - GET /runs/:id 404 + happy-path data shape edges

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
  // isKubernetes / isK8sJobDone live here in some builds; harmless when unused.
  isKubernetes: () => false,
}))
mock.module('child_process', () => ({ spawn: () => ({}), execSync: () => '' }))

// Force isProcessAlive(pid) → false so the "dead local process" branch fires.
mock.module('../lib/process-alive', () => ({
  isProcessAlive: () => false,
}))

type Run = {
  id: string; track: string; model: string; status: string;
  startedAt: Date | null; createdAt: Date; completedAt?: Date | null;
  summary?: any; cost?: any; byCategory?: any; results?: Result[];
  pid?: number | null; progress?: any; jobName?: string | null;
}
type Result = {
  runId: string; evalId: string; name: string; category: string; level: number;
  passed: boolean; score: number; maxScore: number; percentage: number;
  durationMs?: number | null; toolCallCount?: number | null; failedToolCalls?: any;
  iterations?: number | null; tokens?: any; phaseScores?: any; log?: string | null;
  criteria?: any; createdAt: Date; pipeline?: string | null; pipelinePhase?: number | null;
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
    findUnique: async (args: any) => {
      const r = runs.get(args?.where?.id)
      if (!r) return null
      if (args?.include?.results) {
        return { ...r, results: results.filter((x) => x.runId === r.id) }
      }
      return r
    },
    findFirst: async () => null,
    update: async (args: any) => {
      const r = runs.get(args?.where?.id)
      if (!r) return null
      Object.assign(r, args.data)
      return r
    },
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
        list = list.filter((r: any) => (runs.get(r.runId)?.status === args.where.run.status))
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
  // Force isKubernetes() === false so the dead-local-process branch is reachable.
  delete process.env.KUBERNETES_SERVICE_HOST

function seedRun(p: Partial<Run> = {}): Run {
  const run: Run = {
    id: `run_${runs.size + 1}`,
    track: 'agentic',
    model: 'sonnet',
    status: 'completed',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: null,
    summary: { total: 1, passed: 1, failed: 0, passRate: 100, avgScore: 5, totalPoints: 5, maxPoints: 5 },
    cost: null,
    byCategory: null,
    pid: null,
    progress: null,
    jobName: null,
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
    tokens: null, phaseScores: null, log: null,
    criteria: null, createdAt: new Date('2026-01-01T00:00:00Z'),
    pipeline: null, pipelinePhase: null,
    ...p,
  } as Result
  results.push(r)
  return r
}

// ─── /analytics/overview — phaseScores aggregation ────────────────────────

describe('GET /analytics/overview — intentionVsExecution + pipeline analysis', () => {
  test('aggregates phaseScores into intention vs execution gap, sorted desc by gap', async () => {
    const run = seedRun()
    // Eval A: intention 90, execution 60 → gap 30 (largest)
    seedResult({
      runId: run.id, evalId: 'eA', passed: true,
      phaseScores: { intention: { percentage: 90 }, execution: { percentage: 60 } },
    })
    // Eval B: intention 70, execution 50 → gap 20
    seedResult({
      runId: run.id, evalId: 'eB', passed: true,
      phaseScores: { intention: { percentage: 70 }, execution: { percentage: 50 } },
    })
    // Eval C: phaseScores missing intention → skipped entirely
    seedResult({
      runId: run.id, evalId: 'eC', passed: true,
      phaseScores: { execution: { percentage: 80 } },
    })
    // Eval D: phaseScores null → skipped
    seedResult({ runId: run.id, evalId: 'eD', passed: true, phaseScores: null })

    const res = await admin.fetch(new Request('http://t/analytics/overview'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const ive = body.data.intentionVsExecution as Array<any>
    expect(ive.length).toBe(2)
    expect(ive[0].evalId).toBe('eA')
    expect(ive[0].gap).toBe(30)
    expect(ive[0].intention).toBe(90)
    expect(ive[0].execution).toBe(60)
    expect(ive[1].evalId).toBe('eB')
    expect(ive[1].gap).toBe(20)
    expect(ive[0].runCount).toBe(1)
  })

  test('averages intention + execution across multiple runs of the same evalId', async () => {
    const r1 = seedRun({ id: 'run_a' })
    const r2 = seedRun({ id: 'run_b' })
    seedResult({
      runId: r1.id, evalId: 'shared', passed: true,
      phaseScores: { intention: { percentage: 80 }, execution: { percentage: 60 } },
    })
    seedResult({
      runId: r2.id, evalId: 'shared', passed: true,
      phaseScores: { intention: { percentage: 100 }, execution: { percentage: 40 } },
    })

    const res = await admin.fetch(new Request('http://t/analytics/overview'))
    const body: any = await res.json()
    const ive = body.data.intentionVsExecution as Array<any>
    expect(ive.length).toBe(1)
    expect(ive[0].evalId).toBe('shared')
    expect(ive[0].intention).toBe(90) // (80+100)/2
    expect(ive[0].execution).toBe(50) // (60+40)/2
    expect(ive[0].gap).toBe(40)
    expect(ive[0].runCount).toBe(2)
  })

  test('pipeline phase pass-rate is computed and sorted by phase ascending', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'p1', passed: true, pipeline: 'preflight', pipelinePhase: 1 })
    seedResult({ runId: run.id, evalId: 'p2', passed: false, pipeline: 'preflight', pipelinePhase: 1 })
    seedResult({ runId: run.id, evalId: 'p3', passed: true, pipeline: 'preflight', pipelinePhase: 2 })
    seedResult({ runId: run.id, evalId: 'p4', passed: true, pipeline: 'alt', pipelinePhase: 0 })
    // Result with pipeline but null phase → skipped
    seedResult({ runId: run.id, evalId: 'p5', passed: true, pipeline: 'preflight', pipelinePhase: null })

    const res = await admin.fetch(new Request('http://t/analytics/overview'))
    const body: any = await res.json()
    const pa = body.data.pipelineAnalysis as Array<any>
    expect(pa.length).toBe(2)
    const alt = pa.find((p) => p.pipeline === 'alt')
    const pre = pa.find((p) => p.pipeline === 'preflight')
    expect(alt.phases).toHaveLength(1)
    expect(alt.phases[0]).toMatchObject({ phase: 0, total: 1, passed: 1, passRate: 100 })
    // preflight sorted asc by phase: 1 then 2
    expect(pre.phases.map((p: any) => p.phase)).toEqual([1, 2])
    expect(pre.phases[0]).toMatchObject({ phase: 1, total: 2, passed: 1, passRate: 50 })
    expect(pre.phases[1]).toMatchObject({ phase: 2, total: 1, passed: 1, passRate: 100 })
  })

  test('no phaseScores anywhere → empty intentionVsExecution; no pipeline data → empty pipelineAnalysis', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'x' })
    const res = await admin.fetch(new Request('http://t/analytics/overview'))
    const body: any = await res.json()
    expect(body.data.intentionVsExecution).toEqual([])
    expect(body.data.pipelineAnalysis).toEqual([])
  })
})

// ─── /analytics/tool-usage — log parsing branches ─────────────────────────

describe('GET /analytics/tool-usage — log regex parsing', () => {
  test('parses tool-call markdown blocks and counts ERROR markers', async () => {
    const run = seedRun()
    // Log uses the markdown the regex expects: `### N. \`tool_name\``
    const passingLog = [
      '### 1. `read_file`',
      'OK',
      '### 2. `write_file`',
      'OK',
      '### 3. `read_file`',
      'OK',
    ].join('\n')
    const failingLog = [
      '### 1. `read_file` **ERROR**',
      'Failed',
      '### 2. `web_search` **ERROR**',
      'rate limit',
      '### 3. `read_file`',
      'OK',
    ].join('\n')

    seedResult({ runId: run.id, evalId: 'p1', passed: true, toolCallCount: 3, log: passingLog })
    seedResult({ runId: run.id, evalId: 'f1', passed: false, toolCallCount: 3, log: failingLog })

    const res = await admin.fetch(new Request('http://t/analytics/tool-usage'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const tools = body.data.tools as Array<any>

    const readFile = tools.find((t) => t.name === 'read_file')
    expect(readFile).toBeDefined()
    expect(readFile.calls).toBe(4) // 2 from passing log + 2 from failing log
    expect(readFile.errors).toBe(1) // one ERROR marker on the first failing line
    expect(readFile.passingEvals).toBe(1)
    expect(readFile.failingEvals).toBe(1)
    expect(readFile.errorRate).toBeCloseTo((1 / 4) * 100, 4)

    const writeFile = tools.find((t) => t.name === 'write_file')
    expect(writeFile.calls).toBe(1)
    expect(writeFile.errors).toBe(0)
    expect(writeFile.passingEvals).toBe(1)
    expect(writeFile.failingEvals).toBe(0)
    expect(writeFile.errorRate).toBe(0)

    const webSearch = tools.find((t) => t.name === 'web_search')
    expect(webSearch.calls).toBe(1)
    expect(webSearch.errors).toBe(1)
    expect(webSearch.errorRate).toBe(100)
    expect(webSearch.passingEvals).toBe(0)
    expect(webSearch.failingEvals).toBe(1)

    expect(body.data.avgToolCallsPassing).toBe(3)
    expect(body.data.avgToolCallsFailing).toBe(3)
  })

  test('results with no log are skipped entirely', async () => {
    const run = seedRun()
    seedResult({ runId: run.id, evalId: 'no-log', passed: true, toolCallCount: 5, log: null })
    const res = await admin.fetch(new Request('http://t/analytics/tool-usage'))
    const body: any = await res.json()
    expect(body.data.tools).toEqual([])
    // avgToolCallsPassing still computes from passingEvals.toolCallCount even when log is empty.
    expect(body.data.avgToolCallsPassing).toBe(5)
    expect(body.data.avgToolCallsFailing).toBe(0)
  })

  test('tools are returned sorted by call count descending', async () => {
    const run = seedRun()
    const log = [
      '### 1. `a`',
      '### 2. `b`',
      '### 3. `b`',
      '### 4. `c`',
      '### 5. `c`',
      '### 6. `c`',
    ].join('\n')
    seedResult({ runId: run.id, evalId: 'p', passed: true, toolCallCount: 6, log })
    const res = await admin.fetch(new Request('http://t/analytics/tool-usage'))
    const body: any = await res.json()
    const names = (body.data.tools as Array<any>).map((t) => t.name)
    expect(names).toEqual(['c', 'b', 'a'])
  })
})

// ─── GET /runs/:id — 404 + happy-path edges ───────────────────────────────

describe('GET /runs/:id — edges', () => {
  test('404 when run does not exist', async () => {
    const res = await admin.fetch(new Request('http://t/runs/no-such-id'))
    expect(res.status).toBe(404)
    const body: any = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/not found/i)
  })

  test('completed run: progress is undefined, results array is mapped through', async () => {
    const run = seedRun({ id: 'r1', status: 'completed' })
    seedResult({ runId: run.id, evalId: 'a', passed: true, score: 5, maxScore: 5, percentage: 100 })
    seedResult({ runId: run.id, evalId: 'b', passed: false, score: 0, maxScore: 5, percentage: 0 })

    const res = await admin.fetch(new Request('http://t/runs/r1'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.progress).toBeUndefined()
    expect(body.data.results).toHaveLength(2)
    expect(body.data.summary).toBeDefined()
  })

  test('running local run with dead pid + array progress → auto-completes the run', async () => {
    const run = seedRun({
      id: 'r-dead',
      status: 'running',
      pid: 99999,
      progress: [
        { id: 'a', score: 5, max: 5, passed: true },
        { id: 'b', score: 0, max: 5, passed: false },
      ],
    })

    const res = await admin.fetch(new Request('http://t/runs/r-dead'))
    expect(res.status).toBe(200)
    const body: any = await res.json()
    // The handler's update() mutated the in-memory run to status=completed.
    expect(runs.get(run.id)!.status).toBe('completed')
    expect(body.data.summary.total).toBe(2)
    expect(body.data.summary.passed).toBe(1)
    expect(body.data.summary.failed).toBe(1)
    expect(body.data.summary.passRate).toBe(50)
  })

  test('running local run with dead pid + no progress → marks run failed', async () => {
    seedRun({
      id: 'r-failed',
      status: 'running',
      pid: 88888,
      progress: null, // extractProgress returns []
    })

    const res = await admin.fetch(new Request('http://t/runs/r-failed'))
    expect(res.status).toBe(200)
    expect(runs.get('r-failed')!.status).toBe('failed')
  })
})
