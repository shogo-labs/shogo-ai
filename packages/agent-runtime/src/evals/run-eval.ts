#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Runtime Eval Runner
 *
 * Spins up real agent-runtime server(s) and runs evals against them.
 * Spins up real servers and runs evals against agent-runtime.
 *
 * Usage:
 *   bun run src/evals/run-eval.ts --track canvas --model haiku
 *   bun run src/evals/run-eval.ts --track all --model sonnet --workers 2
 *   bun run src/evals/run-eval.ts --track canvas --filter weather
 */

import { spawn, type Subprocess } from 'bun'
import { execSync } from 'child_process'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { resolve, join, dirname } from 'path'

// Load .env.local from repo root so workers inherit API keys
const REPO_ROOT_EARLY = resolve(import.meta.dir, '../../../..')
for (const envFile of ['.env.local', '.env']) {
  const envPath = resolve(REPO_ROOT_EARLY, envFile)
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 0) continue
      const key = trimmed.slice(0, eqIdx)
      const val = trimmed.slice(eqIdx + 1)
      if (!process.env[key]) process.env[key] = val
    }
    break
  }
}
import { runEval } from './runner'
import { resetWorkspaceDefaults } from '../workspace-defaults'
import { CANVAS_EVALS } from './test-cases-canvas'
import { COMPLEX_EVALS } from './test-cases-complex'
import { MEMORY_EVALS } from './test-cases-memory'
import { PERSONALITY_EVALS } from './test-cases-personality'
import { MULTITURN_EVALS } from './test-cases-multiturn'
import { MCP_DISCOVERY_EVALS } from './test-cases-mcp-discovery'
import { MCP_ORCHESTRATION_EVALS } from './test-cases-mcp-orchestration'
import { MCP_VACATION_PLANNER_EVALS } from './test-cases-mcp-vacation-planner'
import { COMPOSIO_EVALS } from './test-cases-composio'
import { TOOL_SYSTEM_EVALS } from './test-cases-tool-system'
import { FILE_UPLOAD_EVALS } from './test-cases-file-upload'
import { REAL_DATA_EVALS } from './test-cases-real-data'
import { TRIP_PLANNER_EVALS } from './test-cases-trip-planner'
import { TEMPLATE_EVALS } from './test-cases-template'
import { RESPONSE_TRANSFORM_EVALS } from './test-cases-response-transforms'
import { modeSwitchingEvals } from './test-cases-mode-switching'
import { CODE_AGENT_EVALS } from './test-cases-code-agent'
import { CODE_AGENT_V2_EVALS } from './test-cases-code-agent-v2'
import { CLI_ROUTING_EVALS } from './test-cases-cli-routing'
import { SKILL_SYSTEM_EVALS } from './test-cases-skill-system'
import { buildMockPayload } from './tool-mocks'
import type { AgentEval, EvalResult, EvalSuiteResult, CategorySummary } from './types'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

function getArg(name: string, defaultValue?: string): string | undefined {
  const eqArg = args.find(a => a.startsWith(`--${name}=`))
  if (eqArg) return eqArg.split('=')[1]
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1]
  return defaultValue
}

const trackArg = getArg('track', 'all')!
const modelArg = getArg('model', 'haiku')!
const workersArg = parseInt(getArg('workers', '1')!)
const filterArg = getArg('filter')
const tagsArg = getArg('tags')
const verboseFlag = args.includes('--verbose') || args.includes('-v')

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-5',
}

const BASE_PORT = 6400
const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const AGENT_RUNTIME_SERVER = resolve(REPO_ROOT, 'packages/agent-runtime/src/server.ts')

// Pricing per token (USD) — cache reads are 90% cheaper, cache writes 25% more
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  haiku: { input: 0.0000008, output: 0.000004, cacheRead: 0.00000008, cacheWrite: 0.000001 },
  sonnet: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
}

function getEvals(track: string): AgentEval[] {
  switch (track) {
    case 'canvas': return CANVAS_EVALS
    case 'complex': return COMPLEX_EVALS
    case 'memory': return MEMORY_EVALS
    case 'personality': return PERSONALITY_EVALS
    case 'multiturn': return MULTITURN_EVALS
    case 'mcp-discovery': return MCP_DISCOVERY_EVALS
    case 'mcp-orchestration': return MCP_ORCHESTRATION_EVALS
    case 'vacation-planner': return MCP_VACATION_PLANNER_EVALS
    case 'composio': return COMPOSIO_EVALS
    case 'tool-system': return TOOL_SYSTEM_EVALS
    case 'file-upload': return FILE_UPLOAD_EVALS
    case 'real-data': return REAL_DATA_EVALS
    case 'trip-planner': return TRIP_PLANNER_EVALS
    case 'template': return TEMPLATE_EVALS
    case 'response-transform': return RESPONSE_TRANSFORM_EVALS
    case 'mode-switching': return modeSwitchingEvals
    case 'code-agent': return CODE_AGENT_EVALS
    case 'code-agent-v2': return CODE_AGENT_V2_EVALS
    case 'cli-routing': return CLI_ROUTING_EVALS
    case 'skill-system': return SKILL_SYSTEM_EVALS
    case 'all': return [...CANVAS_EVALS, ...COMPLEX_EVALS, ...MEMORY_EVALS, ...PERSONALITY_EVALS, ...MULTITURN_EVALS, ...MCP_DISCOVERY_EVALS, ...MCP_ORCHESTRATION_EVALS, ...MCP_VACATION_PLANNER_EVALS, ...COMPOSIO_EVALS, ...TOOL_SYSTEM_EVALS, ...FILE_UPLOAD_EVALS, ...REAL_DATA_EVALS, ...TRIP_PLANNER_EVALS, ...TEMPLATE_EVALS, ...RESPONSE_TRANSFORM_EVALS, ...modeSwitchingEvals, ...CLI_ROUTING_EVALS, ...SKILL_SYSTEM_EVALS]
    default:
      console.error(`Unknown track: ${track}. Valid: canvas, complex, memory, personality, multiturn, mcp-discovery, mcp-orchestration, vacation-planner, composio, tool-system, file-upload, real-data, trip-planner, template, response-transform, mode-switching, code-agent, code-agent-v2, cli-routing, skill-system, all`)
      process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Worker management
// ---------------------------------------------------------------------------

interface Worker {
  id: number
  port: number
  dir: string
  process: Subprocess | null
  busy: boolean
}

async function startWorker(id: number): Promise<Worker> {
  const port = BASE_PORT + id
  const dir = `/tmp/agent-eval-worker-${id}`

  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  resetWorkspaceDefaults(dir)

  console.log(`  Starting worker ${id} on port ${port}...`)

  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' })
  } catch {}
  await Bun.sleep(500)

  const proc = spawn({
    cmd: ['bun', 'run', AGENT_RUNTIME_SERVER],
    env: {
      ...process.env,
      PORT: String(port),
      WORKSPACE_DIR: dir,
      AGENT_DIR: dir,
      PROJECT_DIR: dir,
      PROJECT_ID: `eval-worker-${id}`,
      AGENT_MODEL: modelArg,
      NODE_OPTIONS: '--max-old-space-size=512',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })

  if (proc.exitCode !== null) {
    throw new Error(`Worker ${id} exited immediately with code ${proc.exitCode}`)
  }

  const maxWait = 45_000
  const start = Date.now()
  let delay = 500

  while (Date.now() - start < maxWait) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 3_000)
      const res = await fetch(`http://localhost:${port}/health`, { signal: ctl.signal })
      clearTimeout(t)
      if (res.ok) {
        console.log(`  Worker ${id} ready on port ${port} (${Date.now() - start}ms)`)
        return { id, port, dir, process: proc, busy: false }
      }
    } catch {
      if (proc.exitCode !== null) throw new Error(`Worker ${id} died with code ${proc.exitCode}`)
    }
    await Bun.sleep(delay)
    delay = Math.min(delay * 1.2, 2_000)
  }

  proc.kill()
  throw new Error(`Worker ${id} failed to start within ${maxWait}ms`)
}

function stopWorker(w: Worker) {
  w.process?.kill()
  try { execSync(`lsof -ti:${w.port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' }) } catch {}
  if (existsSync(w.dir)) rmSync(w.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Eval execution on a worker
// ---------------------------------------------------------------------------

async function runEvalOnWorker(
  worker: Worker,
  ev: AgentEval,
  index: number,
  total: number,
): Promise<EvalResult> {
  // Clean workspace between evals and re-seed base personality
  try { execSync(`rm -rf ${worker.dir}/* 2>/dev/null || true`, { stdio: 'pipe' }) } catch {}
  resetWorkspaceDefaults(worker.dir)

  // Seed any eval-specific workspace files (e.g. pre-populated MEMORY.md)
  if (ev.workspaceFiles) {
    for (const [relPath, content] of Object.entries(ev.workspaceFiles)) {
      const absPath = join(worker.dir, relPath)
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, content, 'utf-8')
    }
  }

  // Reset the gateway's conversation session so previous evals don't pollute context
  try {
    await fetch(`http://localhost:${worker.port}/agent/session/reset`, { method: 'POST' })
  } catch {}

  // Pre-set visual mode (canvas evals need canvas mode for the system prompt guide)
  const initialMode = ev.initialMode || (ev.category === 'canvas' ? 'canvas' : 'none')
  try {
    await fetch(`http://localhost:${worker.port}/agent/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: initialMode }),
    })
  } catch {}

  // Install tool mocks for deterministic, fast tool execution
  try {
    const mockPayload = buildMockPayload(ev.toolMocks)
    await fetch(`http://localhost:${worker.port}/agent/tool-mocks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mocks: mockPayload }),
    })
  } catch {}

  const startTime = Date.now()
  console.log(`[${index + 1}/${total}] Worker ${worker.id}: ${ev.name}`)

  try {
    const result = await runEval(ev, {
      agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
      timeoutMs: 300_000,
      verbose: verboseFlag,
      workspaceDir: worker.dir,
    })

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    const status = result.passed ? 'PASS' : 'FAIL'
    const tokInfo = result.metrics.tokens.total > 0
      ? ` [${result.metrics.tokens.input}+${result.metrics.tokens.output} tok]`
      : ''
    console.log(`[${index + 1}/${total}] ${status} ${ev.name}: ${result.score}/${ev.maxScore} (${duration}s)${tokInfo}`)
    return result
  } catch (err: any) {
    console.error(`[${index + 1}/${total}] ERROR ${ev.name}: ${err.message}`)
    return {
      eval: ev,
      passed: false,
      score: 0,
      maxScore: ev.maxScore,
      percentage: 0,
      responseText: '',
      toolCalls: [],
      finalTurnToolCalls: [],
      criteriaResults: [],
      triggeredAntiPatterns: [],
      timing: { startTime, endTime: Date.now(), durationMs: Date.now() - startTime },
      metrics: {
        toolCallCount: 0,
        successfulToolCalls: 0,
        failedToolCalls: 0,
        iterations: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        timing: { totalMs: Date.now() - startTime },
      },
      errors: [err.message],
    }
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let globalWorkers: Worker[] = []

function cleanup() {
  console.log('\nCleaning up workers...')
  globalWorkers.forEach(stopWorker)
  globalWorkers = []
}

process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })
process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err); cleanup(); process.exit(1) })

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('AGENT RUNTIME EVAL')
  console.log('='.repeat(60))
  console.log(`  Track:   ${trackArg}`)
  console.log(`  Model:   ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Workers: ${workersArg}`)
  console.log('')

  let evals = getEvals(trackArg)
  if (filterArg) {
    const f = filterArg.toLowerCase()
    evals = evals.filter(e => e.id.toLowerCase().includes(f) || e.name.toLowerCase().includes(f))
  }
  if (tagsArg) {
    const requiredTags = tagsArg.split(',').map(t => t.trim().toLowerCase())
    evals = evals.filter(e => e.tags?.some(t => requiredTags.includes(t.toLowerCase())))
  }

  console.log(`  Evals: ${evals.length}`)
  console.log('')

  if (evals.length === 0) {
    console.log('No evals found')
    process.exit(1)
  }

  // Start workers
  console.log('Starting workers...')
  const workers: Worker[] = []
  try {
    for (let i = 0; i < workersArg; i++) {
      const w = await startWorker(i)
      workers.push(w)
      globalWorkers.push(w)
      if (i < workersArg - 1) await Bun.sleep(1_000)
    }
  } catch (err: any) {
    console.error(`Failed to start workers: ${err.message}`)
    cleanup()
    process.exit(1)
  }

  console.log('')
  console.log('Running evals...')
  console.log('-'.repeat(60))

  const overallStart = Date.now()
  const results: EvalResult[] = []
  const evalQueue = [...evals]
  const running = new Map<number, Promise<void>>()

  while (evalQueue.length > 0 || running.size > 0) {
    for (const worker of workers) {
      if (!worker.busy && evalQueue.length > 0) {
        const ev = evalQueue.shift()!
        const idx = evals.length - evalQueue.length - 1
        worker.busy = true
        const p = runEvalOnWorker(worker, ev, idx, evals.length)
          .then(r => { results.push(r); worker.busy = false; running.delete(worker.id) })
          .catch(() => { worker.busy = false; running.delete(worker.id) })
        running.set(worker.id, p)
      }
    }
    if (running.size > 0) await Promise.race([...running.values()])
  }

  const totalTime = (Date.now() - overallStart) / 1000

  // Stop workers
  console.log('')
  console.log('Stopping workers...')
  workers.forEach(stopWorker)
  globalWorkers = []

  // Summary
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const avgScore = results.length > 0
    ? results.reduce((s, r) => s + r.score, 0) / results.length
    : 0
  const totalInput = results.reduce((s, r) => s + r.metrics.tokens.input, 0)
  const totalOutput = results.reduce((s, r) => s + r.metrics.tokens.output, 0)
  const totalCacheRead = results.reduce((s, r) => s + r.metrics.tokens.cacheRead, 0)
  const totalCacheWrite = results.reduce((s, r) => s + r.metrics.tokens.cacheWrite, 0)
  const pricing = PRICING[modelArg] || PRICING.haiku
  const totalCost =
    totalInput * pricing.input +
    totalOutput * pricing.output +
    totalCacheRead * pricing.cacheRead +
    totalCacheWrite * pricing.cacheWrite
  const totalToolCalls = results.reduce((s, r) => s + r.metrics.toolCallCount, 0)
  const totalFailed = results.reduce((s, r) => s + r.metrics.failedToolCalls, 0)

  // Phase scores
  let intentTotal = 0, intentMax = 0, execTotal = 0, execMax = 0
  for (const r of results) {
    if (r.phaseScores) {
      intentTotal += r.phaseScores.intention.score
      intentMax += r.phaseScores.intention.maxScore
      execTotal += r.phaseScores.execution.score
      execMax += r.phaseScores.execution.maxScore
    }
  }

  // By category
  const categories = new Set(evals.map(e => e.category))
  const byCategory: Record<string, CategorySummary> = {}
  for (const cat of categories) {
    const catResults = results.filter(r => r.eval.category === cat)
    const catPassed = catResults.filter(r => r.passed).length
    byCategory[cat] = {
      total: catResults.length,
      passed: catPassed,
      failed: catResults.length - catPassed,
      passRate: catResults.length > 0 ? (catPassed / catResults.length) * 100 : 0,
      avgScore: catResults.length > 0
        ? catResults.reduce((s, r) => s + r.score, 0) / catResults.length
        : 0,
    }
  }

  console.log('')
  console.log('='.repeat(60))
  console.log('RESULTS')
  console.log('='.repeat(60))
  console.log(`  Total:    ${results.length}`)
  console.log(`  Passed:   ${passed} (${(passed / results.length * 100).toFixed(1)}%)`)
  console.log(`  Failed:   ${failed}`)
  console.log(`  Avg Score: ${avgScore.toFixed(1)}`)
  console.log('')

  console.log('INTENTION vs EXECUTION')
  console.log('-'.repeat(40))
  console.log(`  Intention: ${intentMax > 0 ? (intentTotal / intentMax * 100).toFixed(1) : 100}% (${intentTotal}/${intentMax})`)
  console.log(`  Execution: ${execMax > 0 ? (execTotal / execMax * 100).toFixed(1) : 100}% (${execTotal}/${execMax})`)
  console.log('')

  console.log('EFFICIENCY METRICS')
  console.log('-'.repeat(40))
  console.log(`  Total tool calls:   ${totalToolCalls}`)
  console.log(`  Failed tool calls:  ${totalFailed}`)
  console.log(`  Avg tools/eval:     ${(totalToolCalls / results.length).toFixed(1)}`)
  console.log(`  Success rate:       ${totalToolCalls > 0 ? ((1 - totalFailed / totalToolCalls) * 100).toFixed(1) : 100}%`)
  console.log('')

  const cacheHitRate = (totalInput + totalCacheRead + totalCacheWrite) > 0
    ? (totalCacheRead / (totalInput + totalCacheRead + totalCacheWrite) * 100).toFixed(1)
    : '0.0'
  console.log('COST')
  console.log('-'.repeat(40))
  console.log(`  Input tokens:       ${totalInput.toLocaleString()}`)
  console.log(`  Cache read tokens:  ${totalCacheRead.toLocaleString()} (${cacheHitRate}% hit rate)`)
  console.log(`  Cache write tokens: ${totalCacheWrite.toLocaleString()}`)
  console.log(`  Output tokens:      ${totalOutput.toLocaleString()}`)
  console.log(`  Total cost:         $${totalCost.toFixed(4)}`)
  console.log(`  Cost/eval:          $${(totalCost / results.length).toFixed(4)}`)
  console.log(`  Duration:           ${totalTime.toFixed(1)}s`)
  console.log('')

  if (Object.keys(byCategory).length > 1) {
    console.log('BY CATEGORY')
    console.log('-'.repeat(50))
    for (const [cat, summary] of Object.entries(byCategory)) {
      console.log(`  ${cat.padEnd(15)} ${summary.passed}/${summary.total} (${summary.passRate.toFixed(0)}%) avg=${summary.avgScore.toFixed(0)}`)
    }
    console.log('')
  }

  console.log('INDIVIDUAL RESULTS')
  console.log('-'.repeat(70))
  console.log('  Name'.padEnd(42) + 'Score'.padEnd(10) + 'Intent'.padEnd(10) + 'Exec'.padEnd(10) + 'Tools')
  console.log('-'.repeat(70))
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL'
    const name = `${status} ${r.eval.name}`.slice(0, 40)
    const score = `${r.score}/${r.eval.maxScore}`
    const intent = r.phaseScores ? `${r.phaseScores.intention.percentage.toFixed(0)}%` : '-'
    const exec = r.phaseScores ? `${r.phaseScores.execution.percentage.toFixed(0)}%` : '-'
    const tools = String(r.metrics.toolCallCount)
    console.log(`  ${name.padEnd(40)} ${score.padEnd(10)} ${intent.padEnd(10)} ${exec.padEnd(10)} ${tools}`)
  }

  // Save results
  const timestamp = Date.now()
  const outputPath = `/tmp/agent-eval-results-${modelArg}-${trackArg}-${timestamp}.json`
  const exportData: EvalSuiteResult = {
    name: `agent-runtime-${trackArg}`,
    timestamp: new Date().toISOString(),
    model: MODEL_MAP[modelArg] || modelArg,
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      passRate: (passed / results.length) * 100,
      avgScore,
      totalPoints: results.reduce((s, r) => s + r.score, 0),
      maxPoints: results.reduce((s, r) => s + r.maxScore, 0),
    },
    byCategory,
    cost: {
      totalInputTokens: totalInput,
      totalCacheReadTokens: totalCacheRead,
      totalCacheWriteTokens: totalCacheWrite,
      totalOutputTokens: totalOutput,
      totalCost,
      costPerEval: totalCost / results.length,
    },
  }
  writeFileSync(outputPath, JSON.stringify(exportData, null, 2))
  console.log('')
  console.log(`Results saved: ${outputPath}`)
  console.log('='.repeat(60))

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  cleanup()
  process.exit(1)
})
