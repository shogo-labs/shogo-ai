// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Eval Admin Routes
 *
 * Super-admin endpoints for listing past eval runs, viewing detailed results,
 * reading per-eval markdown logs, triggering new runs, checking active runs,
 * and analytics (eval history, tool usage, model comparison, overview).
 *
 * All run state is persisted in the database (eval_runs + eval_run_results tables)
 * so it survives server restarts and works across K8s pods.
 *
 * Internal callback endpoints (progress/complete/fail) are used by run-eval.ts
 * to report results back, secured by EVAL_CALLBACK_SECRET.
 */

import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { MODEL_CATALOG, MODEL_ALIASES } from '@shogo/model-catalog'
import { prisma } from '../lib/prisma'
import { requireSuperAdmin } from '../middleware/super-admin'
import { authMiddleware, requireAuth } from '../middleware/auth'

const AGENT_RUNTIME_DIR = resolve(import.meta.dir, '../../../../packages/agent-runtime')

const VALID_TRACKS = [
  'agentic', 'all', 'persona', 'canvas', 'canvas-v2', 'canvas-v2-lint',
  'complex', 'memory', 'personality', 'multiturn', 'mcp-discovery',
  'mcp-orchestration', 'vacation-planner', 'composio', 'tool-system',
  'file-upload', 'real-data', 'trip-planner', 'template', 'data-processing',
  'cli-routing', 'skill-system', 'skill-server', 'skill-server-templates',
  'skill-server-advanced', 'edit-file', 'channel-connect', 'bug-fix',
  'coding-discipline', 'subagent', 'subagent-code', 'subagent-ab',
  'subagent-coordination', 'teammate-coordination', 'business-user',
  'startup-cto', 'freelancer', 'content-creator', 'event-planner',
  'nonprofit', 'adversarial', 'cross-cutting',
]

const VALID_MODELS = new Set([
  ...Object.keys(MODEL_CATALOG),
  ...Object.keys(MODEL_ALIASES),
])

const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function getCallbackUrl(): string {
  if (isKubernetes()) {
    const ns = process.env.SYSTEM_NAMESPACE || 'shogo-staging-system'
    return `http://api.${ns}.svc.cluster.local:8002`
  }
  const port = process.env.API_PORT || '8002'
  return `http://localhost:${port}`
}

function durationMs(start?: Date | null, end?: Date | null): number | null {
  if (!start || !end) return null
  return end.getTime() - start.getTime()
}

const DEFAULT_COST = { totalCost: 0, costPerEval: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0 }

function normalizeCost(cost: any) {
  if (!cost) return DEFAULT_COST
  return {
    totalCost: cost.totalCost ?? 0,
    costPerEval: cost.costPerEval ?? 0,
    totalInputTokens: cost.totalInputTokens ?? 0,
    totalOutputTokens: cost.totalOutputTokens ?? 0,
    totalCacheReadTokens: cost.totalCacheReadTokens ?? 0,
    totalCacheWriteTokens: cost.totalCacheWriteTokens ?? 0,
  }
}

function mapRunSummary(r: any) {
  return {
    dirName: r.id,
    id: r.id,
    name: `agent-runtime-${r.track}`,
    track: r.track,
    model: r.model,
    workers: r.workers,
    status: r.status,
    label: r.label ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    triggeredBy: r.triggeredBy ?? null,
    error: r.error ?? null,
    timestamp: r.startedAt?.toISOString() ?? r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    durationMs: durationMs(r.startedAt, r.completedAt),
    summary: r.summary ?? { total: 0, passed: 0, failed: 0, passRate: 0, avgScore: 0, totalPoints: 0, maxPoints: 0 },
    cost: normalizeCost(r.cost),
    byCategory: r.byCategory ?? {},
    resources: r.resources ?? null,
  }
}

function mapEvalResult(r: any) {
  return {
    id: r.evalId,
    name: r.name,
    category: r.category,
    level: r.level,
    passed: r.passed,
    score: r.score,
    maxScore: r.maxScore,
    percentage: r.percentage,
    durationMs: r.durationMs,
    tokens: r.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    toolCallCount: r.toolCallCount ?? 0,
    failedToolCalls: r.failedToolCalls ?? 0,
    iterations: r.iterations ?? 0,
    phaseScores: r.phaseScores ?? null,
    pipeline: r.pipeline ?? null,
    pipelinePhase: r.pipelinePhase ?? null,
    triggeredAntiPatterns: Array.isArray(r.antiPatterns) ? r.antiPatterns : [],
    errors: Array.isArray(r.errors) ? r.errors : [],
    runtimeWarnings: Array.isArray(r.warnings) ? r.warnings : [],
    criteriaResults: Array.isArray(r.criteria) ? r.criteria : [],
  }
}

// ---------------------------------------------------------------------------
// Admin routes (super-admin only)
// ---------------------------------------------------------------------------

export function evalAdminRoutes(): Hono {
  const router = new Hono()

  router.use('*', authMiddleware)
  router.use('*', requireAuth)
  router.use('*', requireSuperAdmin)

  // GET /runs — List all eval runs (summary only)
  router.get('/runs', async (c) => {
    const runs = await prisma.evalRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return c.json({
      ok: true,
      data: { runs: runs.map(mapRunSummary) },
    })
  })

  // GET /runs/active — Check if an eval run is currently in progress
  router.get('/runs/active', async (c) => {
    const activeRun = await prisma.evalRun.findFirst({
      where: { status: 'running' },
      orderBy: { createdAt: 'desc' },
    })

    if (!activeRun) {
      return c.json({ ok: true, data: { running: false } })
    }

    if (activeRun.pid && !isKubernetes() && !isProcessAlive(activeRun.pid)) {
      await prisma.evalRun.update({
        where: { id: activeRun.id },
        data: { status: 'failed', error: 'Process exited unexpectedly', completedAt: new Date() },
      })
      return c.json({ ok: true, data: { running: false } })
    }

    const progressRaw = activeRun.progress as any
    const progressResults = Array.isArray(progressRaw)
      ? progressRaw as Array<{ id: string; score: number; max: number; passed: boolean }>
      : (progressRaw?.results ?? []) as Array<{ id: string; score: number; max: number; passed: boolean }>

    const workerStatusArr = (progressRaw && !Array.isArray(progressRaw)) ? (progressRaw.workers ?? []) : []
    const totalEvals = (progressRaw && !Array.isArray(progressRaw)) ? (progressRaw.totalEvals ?? 0) : 0
    const queueRemaining = (progressRaw && !Array.isArray(progressRaw)) ? (progressRaw.queueRemaining ?? 0) : 0

    return c.json({
      ok: true,
      data: {
        running: true,
        id: activeRun.id,
        pid: activeRun.pid,
        track: activeRun.track,
        model: activeRun.model,
        workers: activeRun.workers,
        completed: progressResults.length,
        passed: progressResults.filter((r) => r.passed).length,
        failed: progressResults.filter((r) => !r.passed).length,
        totalEvals,
        queueRemaining,
        workerStatus: workerStatusArr,
        results: progressResults,
        startedAt: activeRun.startedAt?.toISOString() ?? null,
      },
    })
  })

  // GET /runs/:id — Full detail for a single run
  router.get('/runs/:id', async (c) => {
    const id = c.req.param('id')
    const run = await prisma.evalRun.findUnique({
      where: { id },
      include: { results: { orderBy: { createdAt: 'asc' } } },
    })

    if (!run) {
      return c.json({ ok: false, error: 'Run not found' }, 404)
    }

    const progressRaw = run.progress as any
    const extractProgress = (raw: any): Array<{ id: string; score: number; max: number; passed: boolean }> => {
      if (!raw) return []
      if (Array.isArray(raw)) return raw
      return raw.results ?? []
    }

    // Detect dead processes (same check as /runs/active)
    if (run.status === 'running' && run.pid && !isKubernetes() && !isProcessAlive(run.pid)) {
      const progress = extractProgress(progressRaw)
      const allDone = progress.length > 0
      const synthesized = allDone ? {
        total: progress.length,
        passed: progress.filter((r) => r.passed).length,
        failed: progress.filter((r) => !r.passed).length,
        passRate: (progress.filter((r) => r.passed).length / progress.length) * 100,
        avgScore: progress.reduce((s, r) => s + (r.max > 0 ? (r.score / r.max) * 100 : 0), 0) / progress.length,
        totalPoints: progress.reduce((s, r) => s + r.score, 0),
        maxPoints: progress.reduce((s, r) => s + r.max, 0),
      } : undefined
      await prisma.evalRun.update({
        where: { id },
        data: {
          status: allDone ? 'completed' : 'failed',
          error: allDone ? undefined : 'Process exited unexpectedly',
          summary: synthesized as any,
          completedAt: new Date(),
        },
      })
      run.status = allDone ? 'completed' : 'failed'
      if (synthesized) run.summary = synthesized as any
      run.completedAt = new Date()
    }

    const progress = extractProgress(progressRaw)
    const isRunning = run.status === 'running'

    const workerStatusArr = (progressRaw && !Array.isArray(progressRaw)) ? (progressRaw.workers ?? []) : []
    const totalEvals = (progressRaw && !Array.isArray(progressRaw)) ? (progressRaw.totalEvals ?? 0) : 0
    const queueRemaining = (progressRaw && !Array.isArray(progressRaw)) ? (progressRaw.queueRemaining ?? 0) : 0

    const summary = run.summary ?? (isRunning && progress.length > 0 ? {
      total: progress.length,
      passed: progress.filter((r) => r.passed).length,
      failed: progress.filter((r) => !r.passed).length,
      passRate: (progress.filter((r) => r.passed).length / progress.length) * 100,
      avgScore: progress.reduce((s, r) => s + (r.max > 0 ? (r.score / r.max) * 100 : 0), 0) / progress.length,
      totalPoints: progress.reduce((s, r) => s + r.score, 0),
      maxPoints: progress.reduce((s, r) => s + r.max, 0),
    } : { total: 0, passed: 0, failed: 0, passRate: 0, avgScore: 0, totalPoints: 0, maxPoints: 0 })

    return c.json({
      ok: true,
      data: {
        ...mapRunSummary(run),
        summary,
        progress: isRunning ? progress : undefined,
        totalEvals: isRunning ? totalEvals : undefined,
        queueRemaining: isRunning ? queueRemaining : undefined,
        workerStatus: isRunning ? workerStatusArr : undefined,
        results: run.results.map(mapEvalResult),
      },
    })
  })

  // GET /runs/:id/log/:evalId — Markdown log for a specific eval
  router.get('/runs/:id/log/:evalId', async (c) => {
    const runId = c.req.param('id')
    const evalId = c.req.param('evalId')

    const result = await prisma.evalRunResult.findFirst({
      where: { runId, evalId },
      select: { log: true },
    })

    if (!result?.log) {
      return c.json({ ok: false, error: 'Log not found' }, 404)
    }

    return c.json({ ok: true, data: { evalId, content: result.log } })
  })

  // -------------------------------------------------------------------------
  // Analytics endpoints
  // -------------------------------------------------------------------------

  // GET /analytics/overview — Aggregated stats across all completed runs
  router.get('/analytics/overview', async (c) => {
    const results = await prisma.evalRunResult.findMany({
      include: { run: { select: { id: true, track: true, model: true, status: true, createdAt: true } } },
    })

    const completedResults = results.filter((r) => r.run.status === 'completed')

    // Difficulty curve: pass rate by level
    const byLevel: Record<number, { total: number; passed: number }> = {}
    for (const r of completedResults) {
      const lvl = r.level ?? 0
      if (!byLevel[lvl]) byLevel[lvl] = { total: 0, passed: 0 }
      byLevel[lvl].total++
      if (r.passed) byLevel[lvl].passed++
    }
    const difficultyCurve = Object.entries(byLevel)
      .map(([level, d]) => ({ level: Number(level), total: d.total, passed: d.passed, passRate: d.total > 0 ? (d.passed / d.total) * 100 : 0 }))
      .sort((a, b) => a.level - b.level)

    // Category x difficulty heatmap
    const catLevel: Record<string, Record<number, { total: number; passed: number }>> = {}
    for (const r of completedResults) {
      const cat = r.category
      const lvl = r.level ?? 0
      if (!catLevel[cat]) catLevel[cat] = {}
      if (!catLevel[cat][lvl]) catLevel[cat][lvl] = { total: 0, passed: 0 }
      catLevel[cat][lvl].total++
      if (r.passed) catLevel[cat][lvl].passed++
    }
    const heatmap = Object.entries(catLevel).map(([category, levels]) => ({
      category,
      levels: Object.entries(levels).map(([lvl, d]) => ({
        level: Number(lvl),
        total: d.total,
        passed: d.passed,
        passRate: d.total > 0 ? (d.passed / d.total) * 100 : 0,
      })).sort((a, b) => a.level - b.level),
    })).sort((a, b) => a.category.localeCompare(b.category))

    // Intention vs execution gap
    const intentionVsExecution: Array<{ evalId: string; name: string; category: string; intention: number; execution: number; gap: number; runCount: number }> = []
    const evalPhaseMap: Record<string, { name: string; category: string; intentions: number[]; executions: number[] }> = {}
    for (const r of completedResults) {
      const ps = r.phaseScores as any
      if (!ps?.intention || !ps?.execution) continue
      if (!evalPhaseMap[r.evalId]) evalPhaseMap[r.evalId] = { name: r.name, category: r.category, intentions: [], executions: [] }
      evalPhaseMap[r.evalId].intentions.push(ps.intention.percentage)
      evalPhaseMap[r.evalId].executions.push(ps.execution.percentage)
    }
    for (const [evalId, data] of Object.entries(evalPhaseMap)) {
      const avgIntent = data.intentions.reduce((s, v) => s + v, 0) / data.intentions.length
      const avgExec = data.executions.reduce((s, v) => s + v, 0) / data.executions.length
      intentionVsExecution.push({
        evalId,
        name: data.name,
        category: data.category,
        intention: Math.round(avgIntent * 10) / 10,
        execution: Math.round(avgExec * 10) / 10,
        gap: Math.round((avgIntent - avgExec) * 10) / 10,
        runCount: data.intentions.length,
      })
    }
    intentionVsExecution.sort((a, b) => b.gap - a.gap)

    // Pipeline phase pass rates
    const pipelinePhaseStats: Record<string, Record<number, { total: number; passed: number }>> = {}
    for (const r of completedResults) {
      if (!r.pipeline || r.pipelinePhase == null) continue
      if (!pipelinePhaseStats[r.pipeline]) pipelinePhaseStats[r.pipeline] = {}
      if (!pipelinePhaseStats[r.pipeline][r.pipelinePhase]) pipelinePhaseStats[r.pipeline][r.pipelinePhase] = { total: 0, passed: 0 }
      pipelinePhaseStats[r.pipeline][r.pipelinePhase].total++
      if (r.passed) pipelinePhaseStats[r.pipeline][r.pipelinePhase].passed++
    }
    const pipelineAnalysis = Object.entries(pipelinePhaseStats).map(([pipeline, phases]) => ({
      pipeline,
      phases: Object.entries(phases).map(([phase, d]) => ({
        phase: Number(phase),
        total: d.total,
        passed: d.passed,
        passRate: d.total > 0 ? (d.passed / d.total) * 100 : 0,
      })).sort((a, b) => a.phase - b.phase),
    })).sort((a, b) => a.pipeline.localeCompare(b.pipeline))

    return c.json({
      ok: true,
      data: {
        totalResults: completedResults.length,
        difficultyCurve,
        heatmap,
        intentionVsExecution,
        pipelineAnalysis,
      },
    })
  })

  // GET /analytics/eval-history/:evalId — Per-eval pass/fail history across runs
  router.get('/analytics/eval-history/:evalId', async (c) => {
    const evalId = c.req.param('evalId')

    const results = await prisma.evalRunResult.findMany({
      where: { evalId },
      include: { run: { select: { id: true, track: true, model: true, status: true, startedAt: true, createdAt: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const completedResults = results.filter((r) => r.run.status === 'completed')
    if (completedResults.length === 0) {
      return c.json({ ok: true, data: { evalId, history: [] } })
    }

    const first = completedResults[0]

    return c.json({
      ok: true,
      data: {
        evalId,
        name: first.name,
        category: first.category,
        level: first.level,
        maxScore: first.maxScore,
        history: completedResults.map((r) => ({
          runId: r.run.id,
          track: r.run.track,
          model: r.run.model,
          timestamp: r.run.startedAt?.toISOString() ?? r.run.createdAt.toISOString(),
          passed: r.passed,
          score: r.score,
          maxScore: r.maxScore,
          percentage: r.percentage,
          durationMs: r.durationMs,
          toolCallCount: r.toolCallCount,
          failedToolCalls: r.failedToolCalls,
          iterations: r.iterations,
          tokens: r.tokens ?? null,
          phaseScores: r.phaseScores ?? null,
        })),
      },
    })
  })

  // GET /analytics/tool-usage — Aggregated tool usage from logs
  router.get('/analytics/tool-usage', async (c) => {
    const results = await prisma.evalRunResult.findMany({
      where: { run: { status: 'completed' } },
      select: {
        evalId: true,
        name: true,
        passed: true,
        toolCallCount: true,
        failedToolCalls: true,
        log: true,
      },
    })

    // Parse tool names from log markdown (### N. `tool_name` headers)
    const toolRe = /^### \d+\.\s+`([^`]+)`/gm
    const toolErrorRe = /^### \d+\.\s+`([^`]+)`.*\*\*ERROR\*\*/gm
    const toolStats: Record<string, { calls: number; errors: number; passingEvals: number; failingEvals: number }> = {}

    for (const r of results) {
      if (!r.log) continue
      const toolsUsed = new Set<string>()
      let match: RegExpExecArray | null
      toolRe.lastIndex = 0
      while ((match = toolRe.exec(r.log)) !== null) {
        const name = match[1]
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, passingEvals: 0, failingEvals: 0 }
        toolStats[name].calls++
        toolsUsed.add(name)
      }
      toolErrorRe.lastIndex = 0
      while ((match = toolErrorRe.exec(r.log)) !== null) {
        const name = match[1]
        if (toolStats[name]) toolStats[name].errors++
      }
      for (const name of toolsUsed) {
        if (r.passed) toolStats[name].passingEvals++
        else toolStats[name].failingEvals++
      }
    }

    const passingEvals = results.filter((r) => r.passed)
    const failingEvals = results.filter((r) => !r.passed)
    const avgToolCallsPassing = passingEvals.length > 0
      ? passingEvals.reduce((s, r) => s + r.toolCallCount, 0) / passingEvals.length
      : 0
    const avgToolCallsFailing = failingEvals.length > 0
      ? failingEvals.reduce((s, r) => s + r.toolCallCount, 0) / failingEvals.length
      : 0

    return c.json({
      ok: true,
      data: {
        tools: Object.entries(toolStats)
          .map(([name, stats]) => ({
            name,
            ...stats,
            errorRate: stats.calls > 0 ? (stats.errors / stats.calls) * 100 : 0,
          }))
          .sort((a, b) => b.calls - a.calls),
        avgToolCallsPassing: Math.round(avgToolCallsPassing * 10) / 10,
        avgToolCallsFailing: Math.round(avgToolCallsFailing * 10) / 10,
      },
    })
  })

  // GET /analytics/model-comparison — Compare models on same track
  router.get('/analytics/model-comparison', async (c) => {
    const track = c.req.query('track')

    const where: any = { status: 'completed' }
    if (track) where.track = track

    const runs = await prisma.evalRun.findMany({
      where,
      include: { results: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    })

    // Group by model, pick the most recent run per model
    const byModel: Record<string, typeof runs[0]> = {}
    for (const run of runs) {
      if (!byModel[run.model]) byModel[run.model] = run
    }

    const models = Object.entries(byModel).map(([model, run]) => ({
      model,
      runId: run.id,
      track: run.track,
      timestamp: run.startedAt?.toISOString() ?? run.createdAt.toISOString(),
      summary: run.summary ?? { total: 0, passed: 0, failed: 0, passRate: 0, avgScore: 0, totalPoints: 0, maxPoints: 0 },
      cost: normalizeCost(run.cost),
      byCategory: run.byCategory ?? {},
      results: run.results.map((r) => ({
        evalId: r.evalId,
        name: r.name,
        passed: r.passed,
        score: r.score,
        maxScore: r.maxScore,
        percentage: r.percentage,
      })),
    }))

    // Build per-eval comparison matrix
    const allEvalIds = new Set<string>()
    for (const m of models) {
      for (const r of m.results) allEvalIds.add(r.evalId)
    }
    const comparison = [...allEvalIds].map((evalId) => {
      const row: Record<string, any> = { evalId }
      for (const m of models) {
        const result = m.results.find((r) => r.evalId === evalId)
        row[m.model] = result ? { passed: result.passed, score: result.score, maxScore: result.maxScore, percentage: result.percentage } : null
      }
      return row
    })

    return c.json({
      ok: true,
      data: { models, comparison, availableTracks: [...new Set(runs.map((r) => r.track))] },
    })
  })

  // POST /export — Export training data
  router.post('/export', async (c) => {
    const body = await c.req.json() as {
      runIds: string[]
      filter?: 'passing' | 'failing' | 'all'
      format?: 'jsonl' | 'json'
    }

    const { runIds, filter = 'all', format = 'jsonl' } = body

    const results = await prisma.evalRunResult.findMany({
      where: {
        runId: { in: runIds },
        ...(filter === 'passing' ? { passed: true } : filter === 'failing' ? { passed: false } : {}),
      },
      include: { run: { select: { track: true, model: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const exported = results.map((r) => {
      const ps = r.phaseScores as any
      const intentPct = ps?.intention?.percentage ?? null
      const execPct = ps?.execution?.percentage ?? null
      let quality: 'good' | 'needs_improvement' | 'bad'
      if (!r.passed) quality = 'bad'
      else if (r.percentage >= 90) quality = 'good'
      else quality = 'needs_improvement'

      // Parse response text from log
      let responseText: string | null = null
      let toolCalls: string | null = null
      if (r.log) {
        const respMatch = r.log.match(/## Agent Response\n([\s\S]*?)(?=\n## |$)/)
        if (respMatch) responseText = respMatch[1].trim()
        const toolMatch = r.log.match(/## Tool Calls[\s\S]*?(?=\n## (?!.*Tool)|$)/)
        if (toolMatch) toolCalls = toolMatch[0]
      }

      return {
        evalId: r.evalId,
        name: r.name,
        category: r.category,
        level: r.level,
        track: r.run.track,
        model: r.run.model,
        passed: r.passed,
        score: r.score,
        maxScore: r.maxScore,
        percentage: r.percentage,
        quality,
        intentionScore: intentPct,
        executionScore: execPct,
        intentExecutionGap: intentPct != null && execPct != null ? intentPct - execPct : null,
        toolCallCount: r.toolCallCount,
        failedToolCalls: r.failedToolCalls,
        iterations: r.iterations,
        durationMs: r.durationMs,
        tokens: r.tokens,
        criteriaResults: r.criteria,
        responseText,
        toolCalls,
      }
    })

    if (format === 'jsonl') {
      const lines = exported.map((r) => JSON.stringify(r)).join('\n')
      c.header('Content-Type', 'application/x-ndjson')
      c.header('Content-Disposition', `attachment; filename="eval-export-${Date.now()}.jsonl"`)
      return c.body(lines)
    }

    return c.json({ ok: true, data: exported })
  })

  // POST /runs/trigger — Start a new eval run
  router.post('/runs/trigger', async (c) => {
    const existing = await prisma.evalRun.findFirst({
      where: { status: 'running' },
    })
    if (existing) {
      return c.json({ ok: false, error: 'An eval run is already in progress', id: existing.id }, 409)
    }

    const body = await c.req.json() as {
      track?: string
      model?: string
      workers?: number
      local?: boolean
      vm?: boolean
    }

    const track = body.track ?? 'agentic'
    const model = body.model ?? 'sonnet'
    const workers = Math.min(Math.max(body.workers ?? 1, 1), 8)
    const local = body.local ?? false
    const vm = body.vm ?? false

    if (!VALID_TRACKS.includes(track)) {
      return c.json({ ok: false, error: `Invalid track: ${track}` }, 400)
    }
    if (!VALID_MODELS.has(model)) {
      return c.json({ ok: false, error: `Invalid model: ${model}` }, 400)
    }

    const auth = c.get('auth')
    const run = await prisma.evalRun.create({
      data: {
        track,
        model,
        workers,
        status: 'running',
        triggeredBy: auth?.userId ?? null,
        startedAt: new Date(),
      },
    })

    const callbackUrl = getCallbackUrl()
    const callbackSecret = process.env.EVAL_CALLBACK_SECRET || 'dev-eval-secret'

    if (isKubernetes() && !local) {
      try {
        const { createEvalJob } = await import('../lib/eval-job-manager')
        const jobName = await createEvalJob({
          runId: run.id,
          track,
          model,
          workers,
          callbackUrl,
          callbackSecret,
        })
        await prisma.evalRun.update({
          where: { id: run.id },
          data: { jobName },
        })
        return c.json({
          ok: true,
          data: { started: true, id: run.id, jobName, track, model, workers, local: false },
        })
      } catch (err: any) {
        await prisma.evalRun.update({
          where: { id: run.id },
          data: { status: 'failed', error: `Failed to create K8s Job: ${err.message}`, completedAt: new Date() },
        })
        return c.json({ ok: false, error: `Failed to create K8s Job: ${err.message}` }, 500)
      }
    }

    const args = [
      'run', 'src/evals/run-eval.ts',
      '--track', track,
      '--model', model,
      '--workers', String(workers),
      '--run-id', run.id,
      '--callback-url', callbackUrl,
    ]
    if (local) args.push('--local')
    if (vm) args.push('--vm')

    const bunBin = process.env.SHOGO_BUN_PATH || 'bun'
    console.log(`[EvalTrigger] Spawning: ${bunBin} ${args.join(' ')}`)
    console.log(`[EvalTrigger] CWD: ${AGENT_RUNTIME_DIR}`)
    const child = spawn(bunBin, args, {
      cwd: AGENT_RUNTIME_DIR,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, EVAL_CALLBACK_SECRET: callbackSecret },
    })
    child.stdout?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean))
        console.log(`[Eval:${run.id.slice(0, 8)}] ${line}`)
    })
    child.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean))
        console.error(`[Eval:${run.id.slice(0, 8)}] ${line}`)
    })
    child.on('error', (err) => {
      console.error(`[EvalTrigger] Failed to spawn eval process:`, err.message)
    })
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        console.error(`[EvalTrigger] Eval process exited: code=${code}, signal=${signal}`)
      }
    })
    child.unref()

    const pid = child.pid ?? null
    await prisma.evalRun.update({
      where: { id: run.id },
      data: { pid },
    })

    return c.json({
      ok: true,
      data: { started: true, id: run.id, pid, track, model, workers, local, vm },
    })
  })

  // POST /runs/:id/cancel — Cancel a running eval
  router.post('/runs/:id/cancel', async (c) => {
    const id = c.req.param('id')
    const run = await prisma.evalRun.findUnique({ where: { id } })

    if (!run || run.status !== 'running') {
      return c.json({ ok: false, error: 'No running eval with that ID' }, 404)
    }

    if (run.pid && !isKubernetes()) {
      try { process.kill(run.pid, 'SIGTERM') } catch { /* already dead */ }
    }

    if (run.jobName && isKubernetes()) {
      try {
        const { deleteEvalJob } = await import('../lib/eval-job-manager')
        await deleteEvalJob(run.jobName)
      } catch { /* best-effort */ }
    }

    await prisma.evalRun.update({
      where: { id },
      data: { status: 'cancelled', completedAt: new Date() },
    })

    return c.json({ ok: true })
  })

  // PATCH /runs/:id — Update label and/or tags on a run
  router.patch('/runs/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json() as { label?: string | null; tags?: string[] }

    const run = await prisma.evalRun.findUnique({ where: { id } })
    if (!run) {
      return c.json({ ok: false, error: 'Run not found' }, 404)
    }

    const data: Record<string, any> = {}
    if ('label' in body) data.label = body.label ?? null
    if ('tags' in body) {
      if (!Array.isArray(body.tags)) {
        return c.json({ ok: false, error: 'tags must be an array of strings' }, 400)
      }
      data.tags = body.tags.filter((t): t is string => typeof t === 'string' && t.length > 0)
    }

    if (Object.keys(data).length === 0) {
      return c.json({ ok: false, error: 'No fields to update' }, 400)
    }

    const updated = await prisma.evalRun.update({ where: { id }, data })
    return c.json({ ok: true, data: mapRunSummary(updated) })
  })

  // DELETE /runs/:id — Delete a completed/failed/cancelled run and its results
  router.delete('/runs/:id', async (c) => {
    const id = c.req.param('id')
    const run = await prisma.evalRun.findUnique({ where: { id } })

    if (!run) {
      return c.json({ ok: false, error: 'Run not found' }, 404)
    }

    if (run.status === 'running' || run.status === 'pending') {
      return c.json({ ok: false, error: 'Cannot delete a running or pending eval run. Cancel it first.' }, 409)
    }

    await prisma.evalRun.delete({ where: { id } })
    return c.json({ ok: true })
  })

  return router
}

// ---------------------------------------------------------------------------
// Internal callback routes (called by run-eval.ts, secured by shared secret)
// ---------------------------------------------------------------------------

function validateCallbackSecret(c: any): boolean {
  const secret = process.env.EVAL_CALLBACK_SECRET || 'dev-eval-secret'
  const authHeader = c.req.header('authorization')
  return authHeader === `Bearer ${secret}`
}

export function evalInternalRoutes(): Hono {
  const router = new Hono()

  // POST /evals/:id/progress — Update partial results during a run
  router.post('/evals/:id/progress', async (c) => {
    if (!validateCallbackSecret(c)) {
      return c.json({ ok: false, error: 'Invalid callback secret' }, 401)
    }

    const id = c.req.param('id')
    const body = await c.req.json() as {
      results: Array<{ id: string; score: number; max: number; passed: boolean }>
      totalEvals?: number
      queueLength?: number
      queueRemaining?: number
      workers?: Array<{
        workerId: number
        containerName: string
        status: string
        currentEval?: string
        currentEvalName?: string
        pipeline?: string
        pipelinePhase?: number
        pipelineTotal?: number
        evalsCompleted: number
        startedAt?: string
      }>
    }

    const progressData = body.workers
      ? { results: body.results, totalEvals: body.totalEvals, queueLength: body.queueLength, queueRemaining: body.queueRemaining, workers: body.workers }
      : body.results

    await prisma.evalRun.update({
      where: { id },
      data: { progress: progressData as any },
    })

    return c.json({ ok: true })
  })

  // POST /evals/:id/result — Stream a single eval result as it completes (during a running eval)
  router.post('/evals/:id/result', async (c) => {
    if (!validateCallbackSecret(c)) {
      return c.json({ ok: false, error: 'Invalid callback secret' }, 401)
    }

    const runId = c.req.param('id')
    const body = await c.req.json() as {
      result: {
        eval: { id: string; name: string; category: string; level?: number; pipeline?: string; pipelinePhase?: number }
        passed: boolean
        score: number
        maxScore: number
        percentage: number
        timing: { startTime: number; endTime: number; durationMs: number }
        metrics: { tokens: any; toolCallCount: number; failedToolCalls: number; iterations: number }
        phaseScores: any
        criteriaResults: any[]
        triggeredAntiPatterns: string[]
        errors?: string[]
        runtimeWarnings?: string[]
      }
      log: string | null
    }

    const r = body.result
    try {
      await prisma.evalRunResult.create({
        data: {
          runId,
          evalId: r.eval.id,
          name: r.eval.name,
          category: r.eval.category,
          level: r.eval?.level ?? null,
          passed: r.passed,
          score: r.score,
          maxScore: r.maxScore,
          percentage: r.percentage,
          durationMs: r.timing?.durationMs ?? 0,
          tokens: r.metrics?.tokens ?? null,
          toolCallCount: r.metrics?.toolCallCount ?? 0,
          failedToolCalls: r.metrics?.failedToolCalls ?? 0,
          iterations: r.metrics?.iterations ?? 0,
          phaseScores: r.phaseScores ?? null,
          pipeline: r.eval?.pipeline ?? null,
          pipelinePhase: r.eval?.pipelinePhase ?? null,
          criteria: (r.criteriaResults ?? []).map((cr: any) => ({
            description: cr.criterion?.description ?? '',
            phase: cr.criterion?.phase ?? '',
            points: cr.criterion?.points ?? 0,
            pointsEarned: cr.pointsEarned ?? 0,
            passed: cr.passed,
          })),
          antiPatterns: r.triggeredAntiPatterns ?? [],
          errors: r.errors ?? [],
          warnings: r.runtimeWarnings ?? [],
          log: body.log,
        },
      })
    } catch (err: any) {
      console.error(`[eval-admin] Failed to create result for ${r.eval.id}: ${err.message}`)
    }

    return c.json({ ok: true })
  })

  // POST /evals/:id/complete — Store final results and mark run as completed
  router.post('/evals/:id/complete', async (c) => {
    if (!validateCallbackSecret(c)) {
      return c.json({ ok: false, error: 'Invalid callback secret' }, 401)
    }

    const id = c.req.param('id')
    const body = await c.req.json() as {
      suite: {
        name: string
        model: string
        timestamp: string
        summary: any
        cost: any
        byCategory: any
        resources?: any
        results: any[]
      }
      logs: Record<string, string>
    }

    const { suite, logs } = body

    const resultRows = suite.results.map((r: any) => ({
      runId: id,
      evalId: r.eval?.id ?? 'unknown',
      name: r.eval?.name ?? 'unknown',
      category: r.eval?.category ?? 'unknown',
      level: r.eval?.level ?? null,
      passed: r.passed,
      score: r.score,
      maxScore: r.maxScore,
      percentage: r.percentage,
      durationMs: r.timing?.durationMs ?? 0,
      tokens: r.metrics?.tokens ?? null,
      toolCallCount: r.metrics?.toolCallCount ?? 0,
      failedToolCalls: r.metrics?.failedToolCalls ?? 0,
      iterations: r.metrics?.iterations ?? 0,
      phaseScores: r.phaseScores ?? null,
      pipeline: r.eval?.pipeline ?? null,
      pipelinePhase: r.eval?.pipelinePhase ?? null,
      criteria: (r.criteriaResults ?? []).map((cr: any) => ({
        description: cr.criterion?.description ?? '',
        phase: cr.criterion?.phase ?? '',
        points: cr.criterion?.points ?? 0,
        pointsEarned: cr.pointsEarned ?? 0,
        passed: cr.passed,
      })),
      antiPatterns: r.triggeredAntiPatterns ?? [],
      errors: r.errors ?? [],
      warnings: r.runtimeWarnings ?? [],
      log: logs[r.eval?.id] ?? null,
    }))

    await prisma.evalRunResult.deleteMany({ where: { runId: id } })
    for (const row of resultRows) {
      await prisma.evalRunResult.create({ data: row })
    }
    await prisma.evalRun.update({
      where: { id },
      data: {
        status: 'completed',
        model: suite.model,
        summary: suite.summary as any,
        cost: suite.cost as any,
        byCategory: suite.byCategory as any,
        resources: suite.resources as any ?? undefined,
        completedAt: new Date(),
      },
    })

    return c.json({ ok: true })
  })

  // POST /evals/:id/fail — Mark a run as failed
  router.post('/evals/:id/fail', async (c) => {
    if (!validateCallbackSecret(c)) {
      return c.json({ ok: false, error: 'Invalid callback secret' }, 401)
    }

    const id = c.req.param('id')
    const body = await c.req.json() as { error: string }

    await prisma.evalRun.update({
      where: { id },
      data: { status: 'failed', error: body.error, completedAt: new Date() },
    })

    return c.json({ ok: true })
  })

  return router
}
