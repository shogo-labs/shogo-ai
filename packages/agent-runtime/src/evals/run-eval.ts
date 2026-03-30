#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Runtime Eval Runner
 *
 * Spins up real agent-runtime instances and runs evals against them.
 * By default uses Docker containers; pass --local to spawn local bun processes
 * instead (faster iteration, no image rebuild needed).
 *
 * Usage:
 *   bun run src/evals/run-eval.ts --track canvas --model haiku
 *   bun run src/evals/run-eval.ts --track canvas --model haiku --local
 *   bun run src/evals/run-eval.ts --track all --model sonnet --workers 2
 *   bun run src/evals/run-eval.ts --track canvas --filter weather
 *   bun run src/evals/run-eval.ts --track skill-server-advanced --save-workspaces
 *   bun run src/evals/run-eval.ts --track canvas --model haiku --build
 */

import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, cpSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { tmpdir } from 'os'

import {
  type DockerWorker,
  type DockerWorkerConfig,
  evalWorkerConfig,
  loadEnvFromDisk,
  getArg,
  MODEL_MAP,
  PRICING,
  REPO_ROOT,
  DEFAULT_RUNTIME_IMAGE,
  writeDockerEnvFile,
  cleanupDockerEnvFile,
  ensureDockerImage,
  startDockerWorker,
  stopDockerWorker,
  isWorkerHealthy,
  configureWorkerForTask,
  registerCleanupHandlers,
} from './docker-worker'
import { type LocalWorkerConfig, startLocalWorker, stopLocalWorker } from './local-worker'

loadEnvFromDisk(REPO_ROOT)

import { runEval } from './runner'
import { resetWorkspaceDefaults, seedLSPConfig } from '../workspace-defaults'
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
import { DATA_PROCESSING_EVALS } from './test-cases-data-processing'
import { CODE_AGENT_EVALS } from './test-cases-code-agent'
import { CODE_AGENT_V2_EVALS } from './test-cases-code-agent-v2'
import { CANVAS_V2_EVALS } from './test-cases-canvas-v2'
import { CLI_ROUTING_EVALS } from './test-cases-cli-routing'
import { SKILL_SYSTEM_EVALS } from './test-cases-skill-system'
import { SKILL_SERVER_EVALS } from './test-cases-skill-server'
import { SKILL_SERVER_TEMPLATE_EVALS } from './test-cases-skill-server-templates'
import { EDIT_FILE_EVALS } from './test-cases-edit-file'
import { CHANNEL_CONNECT_EVALS } from './test-cases-channel-connect'
import { CANVAS_V2_LINT_EVALS } from './test-cases-canvas-v2-lint'
import { BUG_FIX_EVALS } from './test-cases-bug-fix'
import { CODING_DISCIPLINE_EVALS } from './test-cases-coding-discipline'
import { SKILL_SERVER_ADVANCED_EVALS } from './test-cases-skill-server-advanced'
import { buildMockPayload } from './tool-mocks'
import type { AgentEval, EvalResult, EvalSuiteResult, CategorySummary } from './types'
import { runRuntimeChecks } from './runtime-checks'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const trackArg = getArg(args, 'track', 'all')!
const modelArg = getArg(args, 'model', 'haiku')!
const workersArg = parseInt(getArg(args, 'workers', '1')!)
const filterArg = getArg(args, 'filter')
const tagsArg = getArg(args, 'tags')
const promptProfileArg = getArg(args, 'prompt-profile') as 'full' | 'swe' | 'general' | undefined
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')
const localFlag = args.includes('--local')
const saveWorkspacesFlag = args.includes('--save-workspaces')

const BASE_PORT = 6400
const SKILL_SERVER_BASE_PORT = 4100
const CONTAINER_SKILL_PORT = 4100

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
    case 'data-processing': return DATA_PROCESSING_EVALS
    case 'code-agent': return CODE_AGENT_EVALS
    case 'code-agent-v2': return CODE_AGENT_V2_EVALS
    case 'canvas-v2': return CANVAS_V2_EVALS
    case 'canvas-v2-lint': return CANVAS_V2_LINT_EVALS
    case 'cli-routing': return CLI_ROUTING_EVALS
    case 'skill-system': return SKILL_SYSTEM_EVALS
    case 'skill-server': return SKILL_SERVER_EVALS
    case 'skill-server-templates': return SKILL_SERVER_TEMPLATE_EVALS
    case 'edit-file': return EDIT_FILE_EVALS
    case 'channel-connect': return CHANNEL_CONNECT_EVALS
    case 'bug-fix': return BUG_FIX_EVALS
    case 'coding-discipline': return CODING_DISCIPLINE_EVALS
    case 'skill-server-advanced': return SKILL_SERVER_ADVANCED_EVALS
    case 'all': return [...CANVAS_V2_EVALS, ...CANVAS_V2_LINT_EVALS, ...COMPLEX_EVALS, ...MEMORY_EVALS, ...PERSONALITY_EVALS, ...MULTITURN_EVALS, ...MCP_DISCOVERY_EVALS, ...MCP_ORCHESTRATION_EVALS, ...MCP_VACATION_PLANNER_EVALS, ...COMPOSIO_EVALS, ...TOOL_SYSTEM_EVALS, ...FILE_UPLOAD_EVALS, ...REAL_DATA_EVALS, ...TRIP_PLANNER_EVALS, ...TEMPLATE_EVALS, ...DATA_PROCESSING_EVALS, ...CLI_ROUTING_EVALS, ...SKILL_SYSTEM_EVALS, ...SKILL_SERVER_EVALS, ...SKILL_SERVER_TEMPLATE_EVALS, ...SKILL_SERVER_ADVANCED_EVALS, ...EDIT_FILE_EVALS, ...CHANNEL_CONNECT_EVALS, ...BUG_FIX_EVALS, ...CODING_DISCIPLINE_EVALS]
    default:
      console.error(`Unknown track: ${track}. Valid: canvas, canvas-v2, canvas-v2-lint, complex, memory, personality, multiturn, mcp-discovery, mcp-orchestration, vacation-planner, composio, tool-system, file-upload, real-data, trip-planner, template, data-processing, code-agent, code-agent-v2, cli-routing, skill-system, skill-server, skill-server-templates, skill-server-advanced, edit-file, channel-connect, bug-fix, coding-discipline, all`)
      process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Workspace archiving (template-compatible format)
// ---------------------------------------------------------------------------

const EVAL_OUTPUTS_DIR = resolve(REPO_ROOT, 'packages/agent-runtime/eval-outputs')

function archiveWorkspaceAsTemplate(
  ev: AgentEval,
  result: EvalResult,
  workspaceDir: string,
  runTimestamp: string,
): string | null {
  if (!existsSync(workspaceDir)) return null

  const destDir = join(EVAL_OUTPUTS_DIR, `${trackArg}-${runTimestamp}`, ev.id)
  mkdirSync(destDir, { recursive: true })

  const templateJson = {
    id: ev.id,
    name: ev.name,
    description: `Eval output for "${ev.name}" (${ev.category}, level ${ev.level})`,
    category: ev.category,
    icon: result.passed ? '✅' : '❌',
    tags: [...(ev.tags || []), 'eval-output', trackArg],
    eval: {
      score: result.score,
      maxScore: result.maxScore,
      percentage: result.percentage,
      passed: result.passed,
      durationMs: result.timing.durationMs,
      model: MODEL_MAP[modelArg] || modelArg,
      timestamp: new Date().toISOString(),
      criteria: result.criteriaResults.map(c => ({
        id: c.criterion.id,
        description: c.criterion.description,
        passed: c.passed,
        points: `${c.pointsEarned}/${c.criterion.points}`,
      })),
    },
    runtime: result.runtimeChecks || null,
    runtimeWarnings: result.runtimeWarnings || [],
  }
  writeFileSync(join(destDir, 'template.json'), JSON.stringify(templateJson, null, 2))

  const shogSrc = join(workspaceDir, '.shogo')
  if (existsSync(shogSrc)) {
    cpSync(shogSrc, join(destDir, '.shogo'), { recursive: true })
  }

  const canvasSrc = join(workspaceDir, 'canvas')
  if (existsSync(canvasSrc)) {
    cpSync(canvasSrc, join(destDir, 'canvas'), { recursive: true })
  }

  const canvasState = join(workspaceDir, '.canvas-state.json')
  if (existsSync(canvasState)) {
    cpSync(canvasState, join(destDir, '.canvas-state.json'))
  }

  const memorySrc = join(workspaceDir, 'memory')
  if (existsSync(memorySrc)) {
    cpSync(memorySrc, join(destDir, 'memory'), { recursive: true })
  }

  const filesSrc = join(workspaceDir, 'files')
  if (existsSync(filesSrc)) {
    cpSync(filesSrc, join(destDir, 'files'), { recursive: true })
  }

  for (const fname of readdirSync(workspaceDir, { withFileTypes: true })) {
    if (!fname.isFile()) continue
    const skip = new Set(['sessions.db', 'sessions.db-wal', 'sessions.db-shm', 'tsconfig.json', 'react-shim.d.ts', 'canvas-globals.d.ts', 'pyrightconfig.json'])
    if (skip.has(fname.name)) continue
    try {
      cpSync(join(workspaceDir, fname.name), join(destDir, fname.name))
    } catch {}
  }

  return destDir
}

// ---------------------------------------------------------------------------
// Eval execution on a worker
// ---------------------------------------------------------------------------

async function runEvalOnWorker(
  worker: DockerWorker,
  ev: AgentEval,
  index: number,
  total: number,
  runTimestamp: string,
): Promise<EvalResult> {
  // Force GC between evals to prevent memory pressure crashes in Bun
  try { Bun.gc(true) } catch {}

  if (verboseFlag) console.log(`      [setup] Cleaning workspace...`)

  // Clean workspace between evals — delete eval-generated content but skip
  // locked files (SQLite DB, etc.) that the worker process holds open.
  if (existsSync(worker.dir)) {
    const safeDirs = ['canvas', 'files', '.shogo/server']
    for (const sub of safeDirs) {
      const p = join(worker.dir, sub)
      try { if (existsSync(p)) rmSync(p, { recursive: true, force: true }) } catch {}
    }
    const keepFiles = new Set(['sessions.db', 'tsconfig.json', 'react-shim.d.ts', 'canvas-globals.d.ts', 'pyrightconfig.json'])
    try {
      for (const entry of readdirSync(worker.dir, { withFileTypes: true })) {
        if (entry.isFile() && !keepFiles.has(entry.name)) {
          try { rmSync(join(worker.dir, entry.name), { force: true }) } catch {}
        }
      }
    } catch {}
  }
  resetWorkspaceDefaults(worker.dir)
  seedLSPConfig(worker.dir)

  if (verboseFlag) console.log(`      [setup] Seeding workspace files...`)

  if (ev.workspaceFiles) {
    for (const [relPath, content] of Object.entries(ev.workspaceFiles)) {
      const absPath = join(worker.dir, relPath)
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, content, 'utf-8')
    }
  }

  const evalLabel = `E${index + 1}:${ev.name.replace(/^[^:]*:\s*/, '').toLowerCase().replace(/\s+/g, '-').substring(0, 30)}`
  const initialMode = ev.initialMode || (ev.category === 'canvas' ? 'canvas' : 'none')

  await configureWorkerForTask(worker, {
    model: modelArg,
    mode: initialMode,
    promptProfile: promptProfileArg,
    evalLabel,
    mocks: buildMockPayload(ev.toolMocks),
    verbose: verboseFlag,
  })

  if (verboseFlag) console.log(`      [setup] Sending eval prompt...`)

  const startTime = Date.now()
  console.log(`[${evalLabel}] Worker ${worker.id}: ${ev.name}`)

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
    console.log(`[${evalLabel}] ${status} ${ev.name}: ${result.score}/${ev.maxScore} (${duration}s)${tokInfo}`)

    if (result.score > 0) {
      const hostSkillPort = SKILL_SERVER_BASE_PORT + worker.id
      const canvasExpected = localFlag ? hostSkillPort : CONTAINER_SKILL_PORT
      const runtimeResults = await runRuntimeChecks({
        workspaceDir: worker.dir,
        skillServerPort: hostSkillPort,
        canvasExpectedPort: canvasExpected,
        evalId: ev.id,
        verbose: verboseFlag,
      })
      if (runtimeResults) {
        result.runtimeChecks = runtimeResults
        result.runtimeWarnings = result.runtimeWarnings || []

        const runtimeCriteria: { id: string; desc: string; pts: number; passed: boolean; skip?: boolean }[] = [
          {
            id: 'runtime-server-healthy',
            desc: 'Skill server boots and responds to /health',
            pts: 2,
            passed: runtimeResults.serverHealthy === true,
          },
          {
            id: 'runtime-crud-functional',
            desc: 'Can list and create records via API',
            pts: 2,
            passed: runtimeResults.canListModels && runtimeResults.canCreateRecord,
          },
          {
            id: 'runtime-canvas-port',
            desc: 'Canvas references the correct skill server port',
            pts: 1,
            passed: runtimeResults.canvasPortCorrect === true,
            skip: runtimeResults.canvasPortCorrect === null,
          },
        ]

        let runtimeBonus = 0
        let runtimeMaxBonus = 0
        for (const rc of runtimeCriteria) {
          if (rc.skip) continue
          runtimeMaxBonus += rc.pts
          const earned = rc.passed ? rc.pts : 0
          runtimeBonus += earned
          result.criteriaResults.push({
            criterion: { id: rc.id, description: rc.desc, points: rc.pts, phase: 'execution', validate: () => rc.passed },
            passed: rc.passed,
            pointsEarned: earned,
          })
        }

        result.score += runtimeBonus
        result.maxScore += runtimeMaxBonus
        result.percentage = result.maxScore > 0 ? (result.score / result.maxScore) * 100 : 0
        result.passed = result.percentage >= 70 && result.triggeredAntiPatterns.length === 0

        if (!runtimeResults.serverHealthy) {
          result.runtimeWarnings.push('Skill server health check failed')
        }
        if (runtimeResults.canvasPortCorrect === false) {
          result.runtimeWarnings.push('Canvas references wrong skill server port')
        }

        const warns = result.runtimeWarnings.length
        if (warns > 0) {
          console.log(`[${evalLabel}] Runtime: ${warns} warning(s) — ${result.runtimeWarnings.join(', ')}`)
        }
        console.log(`[${evalLabel}] Runtime score: +${runtimeBonus}/${runtimeMaxBonus} → ${result.score}/${result.maxScore} (${result.percentage.toFixed(1)}%) ${result.passed ? 'PASS' : 'FAIL'}`)
      }
    }

    if (saveWorkspacesFlag) {
      const archivePath = archiveWorkspaceAsTemplate(ev, result, worker.dir, runTimestamp)
      if (archivePath) {
        result.workspaceDir = archivePath
        console.log(`[${evalLabel}] Workspace saved: ${archivePath}`)
      }
    }

    return result
  } catch (err: any) {
    console.error(`[${evalLabel}] ERROR ${ev.name}: ${err.message}`)
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

let globalWorkers: DockerWorker[] = []
const stopWorker = localFlag ? stopLocalWorker : stopDockerWorker

registerCleanupHandlers(() => globalWorkers, 'agent-eval-crash.log', { stopWorker })

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log(`AGENT RUNTIME EVAL (${localFlag ? 'Local' : 'Docker'})`)
  console.log('='.repeat(60))
  console.log(`  Track:   ${trackArg}`)
  console.log(`  Model:   ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Workers: ${workersArg}`)
  console.log(`  Mode:    ${localFlag ? 'local process' : 'docker container'}`)
  if (saveWorkspacesFlag) console.log(`  Save:    ON (template format)`)
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

  // Docker-specific setup (skipped in local mode)
  let dockerWorkerConfig: DockerWorkerConfig | undefined
  let localWorkerConfig: LocalWorkerConfig | undefined

  if (localFlag) {
    localWorkerConfig = {
      containerPrefix: 'eval-worker',
      baseHostPort: BASE_PORT,
      skillServerBasePort: SKILL_SERVER_BASE_PORT,
      model: modelArg,
      verbose: verboseFlag,
    }
  } else {
    const image = DEFAULT_RUNTIME_IMAGE
    await ensureDockerImage(image, { build: buildFlag })
    writeDockerEnvFile()
    dockerWorkerConfig = evalWorkerConfig({
      image,
      containerPrefix: 'eval-worker',
      baseHostPort: BASE_PORT,
      extraPortMappings: [{ hostBase: SKILL_SERVER_BASE_PORT, container: CONTAINER_SKILL_PORT }],
      model: modelArg,
      verbose: verboseFlag,
    })
  }

  // Start workers
  console.log('Starting workers...')
  const workers: DockerWorker[] = []
  try {
    for (let i = 0; i < workersArg; i++) {
      const w = localFlag
        ? await startLocalWorker(i, localWorkerConfig!)
        : await startDockerWorker(i, dockerWorkerConfig!)
      workers.push(w)
      globalWorkers.push(w)
      if (i < workersArg - 1) await Bun.sleep(1_000)
    }
  } catch (err: any) {
    console.error(`Failed to start workers: ${err.message}`)
    globalWorkers.forEach(stopWorker)
    globalWorkers = []
    if (!localFlag) cleanupDockerEnvFile()
    process.exit(1)
  }

  console.log('')
  console.log('Running evals...')
  console.log('-'.repeat(60))

  const overallStart = Date.now()
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const results: EvalResult[] = []
  const partialPath = resolve(tmpdir(), `agent-eval-partial-${modelArg}-${trackArg}.json`)

  if (saveWorkspacesFlag) {
    const outputDir = join(EVAL_OUTPUTS_DIR, `${trackArg}-${runTimestamp}`)
    mkdirSync(outputDir, { recursive: true })
    console.log(`  Workspaces will be saved to: ${outputDir}`)
    console.log('')
  }

  // Parallel work-pool: each worker pulls the next eval from the queue.
  // Containers are reused across evals; only restart if health check fails.
  let nextIndex = 0
  async function workerLoop(worker: DockerWorker) {
    while (nextIndex < evals.length) {
      const i = nextIndex++
      const ev = evals[i]

      // Check worker health — restart if it died
      if (!(await isWorkerHealthy(worker))) {
        if (verboseFlag) console.log(`      [lifecycle] Worker ${worker.id} unhealthy, restarting...`)
        stopWorker(worker)
        await Bun.sleep(500)
        const fresh = localFlag
          ? await startLocalWorker(worker.id, localWorkerConfig!, { workspaceDir: worker.dir })
          : await startDockerWorker(worker.id, dockerWorkerConfig!, { workspaceDir: worker.dir })
        Object.assign(worker, fresh)
      }

      try {
        const result = await runEvalOnWorker(worker, ev, i, evals.length, runTimestamp)
        results.push(result)
        try { writeFileSync(partialPath, JSON.stringify(results.map(rr => ({ id: rr.eval.id, score: rr.score, max: rr.maxScore, passed: rr.passed })), null, 2)) } catch {}
      } catch (err: any) {
        console.error(`[Worker ${worker.id}] Eval failed: ${err?.message || err}`)
      }
    }
  }

  await Promise.all(workers.map(w => workerLoop(w)))

  const totalTime = (Date.now() - overallStart) / 1000

  // Stop workers
  console.log('')
  console.log('Stopping workers...')
  workers.forEach(stopWorker)
  globalWorkers = []
  if (!localFlag) cleanupDockerEnvFile()

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
  const outputPath = resolve(tmpdir(), `agent-eval-results-${modelArg}-${trackArg}-${timestamp}.json`)
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

  if (saveWorkspacesFlag) {
    const outputDir = join(EVAL_OUTPUTS_DIR, `${trackArg}-${runTimestamp}`)
    console.log('')
    console.log('SAVED WORKSPACES (template format)')
    console.log('-'.repeat(60))
    console.log(`  Directory: ${outputDir}`)
    for (const r of results) {
      if (r.workspaceDir) {
        const status = r.passed ? 'PASS' : 'FAIL'
        console.log(`  ${status} ${r.eval.id} → ${r.workspaceDir}`)
      }
    }
    console.log('')
    console.log('  To load as a template, copy any eval directory into:')
    console.log(`  ${resolve(REPO_ROOT, 'packages/agent-runtime/templates/')}`)
  }

  console.log('='.repeat(60))

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  globalWorkers.forEach(stopWorker)
  globalWorkers = []
  if (!localFlag) cleanupDockerEnvFile()
  process.exit(1)
})
