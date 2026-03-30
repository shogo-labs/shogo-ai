#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Terminal-Bench 2.0 Benchmark Runner
 *
 * Runs the 89 real-world CLI/terminal tasks from Terminal-Bench 2.0.
 * Each task runs in its own Docker environment. The Shogo agent solves
 * it using exec/shell tools, then a verification script checks completion.
 *
 * Prerequisites:
 *   pip install harbor
 *   git clone https://github.com/laude-institute/terminal-bench-2 .terminal-bench/dataset
 *
 * Usage:
 *   bun run src/evals/terminal-bench.ts --model haiku --workers 2
 *   bun run src/evals/terminal-bench.ts --model sonnet --filter "compile" --verbose
 *   bun run src/evals/terminal-bench.ts --model haiku --category security
 *   bun run src/evals/terminal-bench.ts --model haiku --build
 */

import { execSync } from 'child_process'
import {
  mkdirSync, existsSync, writeFileSync, readFileSync,
  readdirSync,
} from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'

import {
  type DockerWorker,
  type DockerWorkerConfig,
  evalWorkerConfig,
  loadEnvFromDisk,
  getArg,
  MODEL_MAP,
  REPO_ROOT,
  DEFAULT_RUNTIME_IMAGE,
  writeDockerEnvFile,
  cleanupDockerEnvFile,
  ensureDockerImage,
  startDockerWorker,
  stopDockerWorker,
  configureWorkerForTask,
  registerCleanupHandlers,
} from './docker-worker'
import { computeCost, printCostSummary, savePartialResults, cleanupPartialFile, printErrorSummary } from './bench-utils'

loadEnvFromDisk(REPO_ROOT)

import { sendTurn, type EvalRunnerConfig, type ParsedAgentResponse } from './runner'
import { buildTerminalBenchPrompt } from './terminal-bench-prompt'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const modelArg = getArg(args, 'model', 'haiku')!
const workersArg = parseInt(getArg(args, 'workers', '1')!)
const filterArg = getArg(args, 'filter')
const categoryArg = getArg(args, 'category')
const dataDir = getArg(args, 'data', resolve(REPO_ROOT, '.terminal-bench/dataset'))!
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')

const BASE_PORT = 7300

// ---------------------------------------------------------------------------
// Task type
// ---------------------------------------------------------------------------

interface TerminalBenchTask {
  id: string
  description: string
  category?: string
  docker_image?: string
  setup_script?: string
  verify_script: string
  timeout_seconds?: number
  difficulty?: string
}

// ---------------------------------------------------------------------------
// Dataset loader
// ---------------------------------------------------------------------------

function loadTasks(): TerminalBenchTask[] {
  // Try JSONL format first
  const jsonlPath = resolve(dataDir, 'tasks.jsonl')
  if (existsSync(jsonlPath)) {
    let raw = readFileSync(jsonlPath, 'utf-8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as TerminalBenchTask)
  }

  // Try JSON array format
  const jsonPath = resolve(dataDir, 'tasks.json')
  if (existsSync(jsonPath)) {
    return JSON.parse(readFileSync(jsonPath, 'utf-8')) as TerminalBenchTask[]
  }

  // Try to load individual task directories
  const tasksDir = resolve(dataDir, 'tasks')
  if (existsSync(tasksDir)) {
    const tasks: TerminalBenchTask[] = []
    for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const taskDir = join(tasksDir, entry.name)
      const configPath = join(taskDir, 'config.json')
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        tasks.push({
          id: config.id || entry.name,
          description: config.description || config.prompt || '',
          category: config.category,
          docker_image: config.docker_image || config.image,
          setup_script: config.setup_script || config.setup,
          verify_script: config.verify_script || config.verify || config.check,
          timeout_seconds: config.timeout_seconds || config.timeout,
          difficulty: config.difficulty,
        })
      }
    }
    if (tasks.length > 0) return tasks
  }

  console.error(`Terminal-Bench dataset not found at: ${dataDir}`)
  console.error(`\nTo prepare the dataset:`)
  console.error(`  mkdir -p ${resolve(REPO_ROOT, '.terminal-bench')}`)
  console.error(`  git clone https://github.com/laude-institute/terminal-bench-2 ${dataDir}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Instance result
// ---------------------------------------------------------------------------

interface InstanceResult {
  task_id: string
  category?: string
  passed: boolean
  durationS: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCalls: number
  error?: string
}

// ---------------------------------------------------------------------------
// Run a single task
// ---------------------------------------------------------------------------

async function runTask(
  worker: DockerWorker,
  task: TerminalBenchTask,
  index: number,
  total: number,
): Promise<InstanceResult> {
  const startTime = Date.now()

  try { Bun.gc(true) } catch {}

  await configureWorkerForTask(worker, {
    model: modelArg,
    mode: 'none',
    promptProfile: 'general',
    evalLabel: undefined,
    verbose: verboseFlag,
  })

  try {
    await fetch(`http://localhost:${worker.port}/agent/session/reset`, { method: 'POST' })
  } catch {}

  // Run setup script if provided
  if (task.setup_script) {
    try {
      execSync(`docker exec "${worker.containerName}" sh -c "${task.setup_script.replace(/"/g, '\\"')}"`, {
        timeout: 60_000,
        stdio: 'pipe',
      })
    } catch (err: any) {
      if (verboseFlag) console.log(`      [setup] Setup script failed: ${err.message}`)
    }
  }

  const prompt = buildTerminalBenchPrompt({
    taskId: task.id,
    description: task.description,
    category: task.category,
  })

  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: (task.timeout_seconds || 600) * 1000,
    verbose: verboseFlag,
    workspaceDir: worker.dir,
  }

  console.log(`[${index + 1}/${total}] ${task.id}${task.category ? ` (${task.category})` : ''} ...`)

  let resp: ParsedAgentResponse
  try {
    const messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }> = [
      { role: 'user', parts: [{ type: 'text', text: prompt }] },
    ]
    resp = await sendTurn(messages, config)
  } catch (err: any) {
    const duration = (Date.now() - startTime) / 1000
    console.log(`[${index + 1}/${total}] ERROR ${task.id}: ${err.message}`)
    return {
      task_id: task.id, category: task.category,
      passed: false, durationS: duration,
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      toolCalls: 0, error: err.message,
    }
  }

  // Run verification script
  let passed = false
  if (task.verify_script) {
    try {
      const verifyCmd = task.verify_script.replace(/"/g, '\\"')
      const output = execSync(
        `docker exec "${worker.containerName}" sh -c "${verifyCmd}"`,
        { encoding: 'utf-8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim()

      passed = output.includes('PASS') || output === '0' || output.toLowerCase() === 'true' || output === 'success'

      if (verboseFlag) console.log(`      [verify] Output: ${output.slice(0, 200)}`)
    } catch (err: any) {
      if (verboseFlag) console.log(`      [verify] Script failed (task not solved): ${err.message.slice(0, 100)}`)
      passed = false
    }
  }

  const duration = (Date.now() - startTime) / 1000
  const status = passed ? 'PASS' : 'FAIL'
  console.log(`[${index + 1}/${total}] ${status} ${task.id} (${duration.toFixed(1)}s, ${resp.toolCalls.length} tools)`)

  return {
    task_id: task.id, category: task.category,
    passed, durationS: duration,
    inputTokens: resp.inputTokens, outputTokens: resp.outputTokens,
    cacheReadTokens: resp.cacheReadTokens, cacheWriteTokens: resp.cacheWriteTokens,
    toolCalls: resp.toolCalls.length,
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let globalWorkers: DockerWorker[] = []

registerCleanupHandlers(() => globalWorkers, 'terminal-bench-crash.log')

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('TERMINAL-BENCH 2.0 BENCHMARK')
  console.log('='.repeat(60))
  console.log(`  Model:     ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Workers:   ${workersArg}`)
  console.log(`  Data:      ${dataDir}`)
  if (categoryArg) console.log(`  Category:  ${categoryArg}`)
  console.log('')

  const tasks = loadTasks()
  let filtered = tasks

  if (categoryArg) {
    const cats = categoryArg.toLowerCase().split(',').map(s => s.trim())
    filtered = filtered.filter(t => t.category && cats.includes(t.category.toLowerCase()))
  }
  if (filterArg) {
    const patterns = filterArg.toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    filtered = filtered.filter(t => {
      const id = t.id.toLowerCase()
      const desc = t.description.toLowerCase()
      return patterns.some(p => id.includes(p) || desc.includes(p))
    })
  }

  const categoryCounts = new Map<string, number>()
  for (const t of filtered) {
    const cat = t.category || 'uncategorized'
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1)
  }
  const catInfo = [...categoryCounts.entries()].map(([c, n]) => `${c}:${n}`).join(' ')

  console.log(`  Tasks:      ${filtered.length}`)
  console.log(`  Categories: ${catInfo}`)
  console.log('')

  if (filtered.length === 0) {
    console.log('No tasks found')
    process.exit(1)
  }

  const image = DEFAULT_RUNTIME_IMAGE
  await ensureDockerImage(image, { build: buildFlag })
  writeDockerEnvFile()

  const numWorkers = Math.min(workersArg, filtered.length)

  console.log('Running benchmark...')
  console.log('-'.repeat(60))

  const overallStart = Date.now()
  const results: InstanceResult[] = new Array(filtered.length)
  const partialPath = resolve(tmpdir(), `terminal-bench-partial-${modelArg}-${Date.now()}.json`)

  let nextIndex = 0

  function savePartial() {
    savePartialResults(partialPath, results)
  }

  const workerConfig = evalWorkerConfig({
    image,
    containerPrefix: 'terminal-bench-worker',
    baseHostPort: BASE_PORT,
    model: modelArg,
    verbose: verboseFlag,
    maxIterations: 150,
  })

  async function workerLoop(workerId: number) {
    const worker = await startDockerWorker(workerId, workerConfig)
    globalWorkers = [...globalWorkers.filter(w => w.id !== workerId), worker]

    while (true) {
      const idx = nextIndex++
      if (idx >= filtered.length) break

      try {
        // For Terminal-Bench, each task may need a fresh container
        // since tasks can modify system state significantly
        stopDockerWorker(worker)
        await Bun.sleep(500)
        const fresh = await startDockerWorker(workerId, workerConfig)
        Object.assign(worker, fresh)
        globalWorkers = [...globalWorkers.filter(w => w.id !== workerId), worker]

        const result = await runTask(worker, filtered[idx], idx, filtered.length)
        results[idx] = result
        savePartial()
      } catch (err: any) {
        console.error(`[${idx + 1}/${filtered.length}] CRASH ${filtered[idx].id}: ${err.message}`)
        results[idx] = {
          task_id: filtered[idx].id, category: filtered[idx].category,
          passed: false, durationS: 0,
          inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          toolCalls: 0, error: err.message,
        }
        savePartial()
      }
    }

    stopDockerWorker(worker)
  }

  console.log(`Starting ${numWorkers} concurrent worker loop(s)...`)
  console.log('')
  await Promise.all(Array.from({ length: numWorkers }, (_, i) => workerLoop(i)))

  const totalTime = (Date.now() - overallStart) / 1000

  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const finalResults = results.filter(Boolean)
  const passed = finalResults.filter(r => r.passed).length
  const withError = finalResults.filter(r => r.error).length

  const cost = computeCost(finalResults, modelArg)

  console.log('')
  console.log('='.repeat(60))
  console.log('TERMINAL-BENCH 2.0 RESULTS')
  console.log('='.repeat(60))
  console.log(`  Model:        ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Total:        ${finalResults.length}`)
  console.log(`  Passed:       ${passed} (${(passed / finalResults.length * 100).toFixed(1)}%)`)
  console.log(`  Failed:       ${finalResults.length - passed}`)
  console.log(`  Errors:       ${withError}`)
  console.log('')

  // By category
  const categories = new Set(finalResults.map(r => r.category || 'uncategorized'))
  for (const cat of categories) {
    const catResults = finalResults.filter(r => (r.category || 'uncategorized') === cat)
    const catPassed = catResults.filter(r => r.passed).length
    console.log(`  ${cat.padEnd(20)} ${catPassed}/${catResults.length} (${(catPassed / catResults.length * 100).toFixed(1)}%)`)
  }
  console.log('')

  printCostSummary(cost, totalTime, 'task')

  // Write results
  const resultsPath = resolve(tmpdir(), `terminal-bench-results-${modelArg}-${Date.now()}.json`)
  writeFileSync(resultsPath, JSON.stringify({
    benchmark: 'terminal-bench-2.0',
    model: MODEL_MAP[modelArg] || modelArg,
    timestamp: new Date().toISOString(),
    results: finalResults,
    summary: {
      total: finalResults.length, passed, withError,
      passRate: `${(passed / finalResults.length * 100).toFixed(1)}%`,
      totalCost: '$' + cost.totalCost.toFixed(2),
      totalDurationS: Math.round(totalTime),
    },
  }, null, 2))
  console.log(`\nResults saved: ${resultsPath}`)

  printErrorSummary(finalResults.filter(r => r.error).map(r => ({ id: r.task_id, error: r.error! })))

  cleanupPartialFile(partialPath)
}

main().catch(err => {
  console.error('Fatal:', err)
  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()
  process.exit(1)
})
