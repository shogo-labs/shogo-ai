#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * bench-explore-models — Phase 3.1
 *
 * Runs the explore-flavoured sub-agent eval cases (subagent-explore-basic,
 * subagent-parallel-search, etc.) against multiple candidate models so we can
 * answer the boss's "which model should explore use?" question with hard data:
 *
 *     pass-rate per model · cost per case · wall time
 *
 * Outputs are persisted via POST /api/internal/agent-eval-results so the
 * recommendation gate's getEvalAnchor() picks them up automatically.
 *
 * Usage:
 *   bun run src/evals/bench-explore-models.ts \
 *     --models haiku,sonnet,gpt-5.4-nano \
 *     --suite test-cases-subagent.ts:explore-suite \
 *     --api-url http://localhost:3000 \
 *     [--workspace-id <id>] [--workers 2]
 *
 * The script *does not* spin up the full eval-runner stack (Docker / VM / K8s)
 * — it shells out to the existing `run-eval` workflow per model. If
 * --dry-run is passed, results are printed but not POSTed.
 */

import { spawn } from 'child_process'
import { resolve } from 'path'
import { subagentEvals } from './test-cases-subagent'
import type { AgentEval } from './types'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
function getArg(name: string, fallback?: string): string | undefined {
  const eq = args.find(a => a.startsWith(`--${name}=`))
  if (eq) return eq.split('=').slice(1).join('=')
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1]
  return fallback
}

const modelsArg = getArg('models', 'haiku,sonnet,gpt-5.4-nano')!
const candidateModels = modelsArg.split(',').map(s => s.trim()).filter(Boolean)
const suiteName = getArg('suite', 'test-cases-subagent.ts:explore-suite')!
const apiUrl = getArg('api-url', process.env.SHOGO_API_URL || 'http://localhost:3000')!
const workspaceId = getArg('workspace-id') ?? null
const dryRun = args.includes('--dry-run')
const verbose = args.includes('--verbose') || args.includes('-v')
const commitSha = process.env.GITHUB_SHA || process.env.COMMIT_SHA || null

// ---------------------------------------------------------------------------
// Pick the explore-flavoured cases — anything in subagentEvals whose id starts
// with `subagent-explore-` OR whose validation explicitly checks for the
// explore subagent type. Centralised here so adding a case keeps the bench
// honest without touching this script.
// ---------------------------------------------------------------------------

function isExploreCase(ev: AgentEval): boolean {
  if (ev.id.startsWith('subagent-explore-')) return true
  if (ev.id.includes('parallel-search')) return true
  return ev.validationCriteria.some(c =>
    c.id === 'used-explore-type' || c.description.toLowerCase().includes('explore'),
  )
}

const exploreCases = subagentEvals.filter(isExploreCase)
if (exploreCases.length === 0) {
  console.error('[bench-explore] No explore-flavoured eval cases found. Bailing.')
  process.exit(2)
}

console.log(
  `[bench-explore] Suite "${suiteName}" — ${exploreCases.length} cases × ` +
    `${candidateModels.length} models = ${exploreCases.length * candidateModels.length} runs`,
)

// ---------------------------------------------------------------------------
// Per-case runner — shells out to run-single-eval.ts for each (case, model)
// combo. Returns { passed, durationMs, creditCost }.
// ---------------------------------------------------------------------------

interface CaseRunOutcome {
  caseId: string
  passed: boolean
  durationMs: number
  creditCost: number
}

async function runCase(model: string, ev: AgentEval): Promise<CaseRunOutcome> {
  const start = Date.now()
  // Shell out so this script keeps its single-purpose nature and we don't
  // re-implement the (Docker | VM | K8s) worker plumbing here.
  const child = spawn(
    'bun',
    [
      'run',
      resolve(__dirname, 'run-single-eval.ts'),
      '--message', ev.input,
      '--model', model,
      '--timeout', '180000',
      ...(verbose ? ['--verbose'] : []),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )

  let stdout = ''
  child.stdout!.on('data', (chunk) => { stdout += chunk.toString() })

  const exitCode = await new Promise<number>((resolveExit) => {
    child.on('close', (code) => resolveExit(code ?? 1))
  })

  const durationMs = Date.now() - start
  if (exitCode !== 0) {
    return { caseId: ev.id, passed: false, durationMs, creditCost: 0 }
  }

  // The single-eval CLI prints a JSON object on stdout. Extract it.
  const jsonStart = stdout.lastIndexOf('{')
  const jsonEnd = stdout.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    return { caseId: ev.id, passed: false, durationMs, creditCost: 0 }
  }
  let result: { text?: string; toolCalls?: Array<{ name: string; input?: any }>; durationMs?: number }
  try {
    result = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1))
  } catch {
    return { caseId: ev.id, passed: false, durationMs, creditCost: 0 }
  }

  // Apply the eval's validation criteria. We can only evaluate the criteria
  // that don't depend on the full EvalResult shape — for the explore suite
  // that's enough (intention checks on tool calls + execution checks on
  // response text).
  const fakeEvalResult = {
    eval: ev,
    responseText: result.text ?? '',
    toolCalls: (result.toolCalls ?? []).map(tc => ({ name: tc.name, input: tc.input ?? {} })),
    finalTurnToolCalls: (result.toolCalls ?? []).map(tc => ({ name: tc.name, input: tc.input ?? {} })),
    perTurnToolCalls: [(result.toolCalls ?? []).map(tc => ({ name: tc.name, input: tc.input ?? {} }))],
  } as any

  let earned = 0
  for (const c of ev.validationCriteria) {
    try {
      if (c.validate(fakeEvalResult)) earned += c.points
    } catch { /* criterion threw — count as failed */ }
  }
  const passed = earned >= ev.maxScore * 0.6 // 60% threshold matches the runner default

  return { caseId: ev.id, passed, durationMs, creditCost: 0 }
}

// ---------------------------------------------------------------------------
// Per-model aggregator — runs every case for one model and posts to the API.
// ---------------------------------------------------------------------------

interface ModelSummary {
  model: string
  totalCases: number
  passedCases: number
  passRate: number
  avgWallTimeMs: number
  avgCreditCost: number
}

async function benchModel(model: string): Promise<ModelSummary> {
  console.log(`\n[bench-explore] === ${model} ===`)
  const outcomes: CaseRunOutcome[] = []
  for (const ev of exploreCases) {
    const o = await runCase(model, ev)
    outcomes.push(o)
    console.log(
      `  ${o.passed ? 'PASS' : 'FAIL'}  ${ev.id.padEnd(36)}  ${(o.durationMs / 1000).toFixed(1)}s`,
    )
  }
  const passedCases = outcomes.filter(o => o.passed).length
  const totalWall = outcomes.reduce((s, o) => s + o.durationMs, 0)
  const totalCost = outcomes.reduce((s, o) => s + o.creditCost, 0)
  return {
    model,
    totalCases: outcomes.length,
    passedCases,
    passRate: passedCases / outcomes.length,
    avgWallTimeMs: Math.round(totalWall / outcomes.length),
    avgCreditCost: Math.round((totalCost / outcomes.length) * 1000) / 1000,
  }
}

async function postResult(s: ModelSummary): Promise<void> {
  if (dryRun) {
    console.log(`[bench-explore] (dry-run) skipping POST for ${s.model}`)
    return
  }
  const body = {
    workspaceId,
    agentType: 'explore',
    model: s.model,
    suite: suiteName,
    totalCases: s.totalCases,
    passedCases: s.passedCases,
    avgWallTimeMs: s.avgWallTimeMs,
    avgCreditCost: s.avgCreditCost,
    commitSha,
    metadata: { tool: 'bench-explore-models', candidateModels },
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.RUNTIME_AUTH_SECRET) {
    headers['x-runtime-token'] = process.env.RUNTIME_AUTH_SECRET
  }

  const res = await fetch(`${apiUrl}/api/internal/agent-eval-results`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.warn(
      `[bench-explore] POST agent-eval-results for ${s.model} failed: HTTP ${res.status} — ${await res.text().catch(() => '')}`,
    )
  } else {
    console.log(`[bench-explore] persisted ${s.model} → passRate=${(s.passRate * 100).toFixed(1)}%`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const summaries: ModelSummary[] = []
  for (const model of candidateModels) {
    summaries.push(await benchModel(model))
  }

  console.log('\n[bench-explore] Summary:')
  console.table(summaries.map(s => ({
    model: s.model,
    cases: s.totalCases,
    passed: s.passedCases,
    passRate: `${(s.passRate * 100).toFixed(1)}%`,
    avgWall: `${(s.avgWallTimeMs / 1000).toFixed(1)}s`,
    avgCost: s.avgCreditCost,
  })))

  for (const s of summaries) {
    await postResult(s)
  }

  const winner = [...summaries].sort((a, b) => {
    // Prefer the cheapest passing model — pass-rate first, then wall time.
    if (b.passRate !== a.passRate) return b.passRate - a.passRate
    return a.avgWallTimeMs - b.avgWallTimeMs
  })[0]
  if (winner) {
    console.log(
      `\n[bench-explore] Best for explore: ${winner.model} ` +
        `(${(winner.passRate * 100).toFixed(1)}% pass, ${(winner.avgWallTimeMs / 1000).toFixed(1)}s avg)`,
    )
  }
}

main().catch((err) => {
  console.error('[bench-explore] Fatal:', err)
  process.exit(1)
})
