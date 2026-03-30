#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WebArena Benchmark Runner
 *
 * Loads WebArena task configs, spins up the agent with Playwright MCP tools,
 * sends each task to the agent, and evaluates completion using WebArena's
 * programmatic evaluator.
 *
 * Prerequisites:
 *   1. Start WebArena environments: docker compose -f src/evals/webarena/docker-compose.yml up -d
 *   2. Clone WebArena repo for evaluator: git clone https://github.com/web-arena-x/webarena .webarena/webarena
 *
 * Usage:
 *   bun run src/evals/webarena.ts --model haiku --workers 1
 *   bun run src/evals/webarena.ts --model sonnet --filter "0,1,2" --verbose
 *   bun run src/evals/webarena.ts --model haiku --domain shopping --workers 2
 *   bun run src/evals/webarena.ts --model haiku --build
 */

import { execSync } from 'child_process'
import {
  mkdirSync, existsSync, writeFileSync, readFileSync,
  appendFileSync,
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

loadEnvFromDisk(REPO_ROOT)

import { computeCost, printCostSummary, savePartialResults, cleanupPartialFile, ensureWorkerHealthy } from './bench-utils'
import { sendTurn, type EvalRunnerConfig, type ParsedAgentResponse } from './runner'
import { buildWebArenaPrompt } from './webarena-prompt'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const modelArg = getArg(args, 'model', 'haiku')!
const workersArg = parseInt(getArg(args, 'workers', '1')!)
const filterArg = getArg(args, 'filter')
const domainArg = getArg(args, 'domain')
const dataDir = getArg(args, 'data', resolve(REPO_ROOT, '.webarena/data'))!
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')

const BASE_PORT = 7600

// WebArena site URLs — these must match docker-compose.yml
const WEBARENA_SITES: Record<string, string> = {
  shopping: process.env.WEBARENA_SHOPPING || 'http://host.docker.internal:7770',
  shopping_admin: process.env.WEBARENA_SHOPPING_ADMIN || 'http://host.docker.internal:7780',
  cms: process.env.WEBARENA_CMS || 'http://host.docker.internal:7790',
  reddit: process.env.WEBARENA_REDDIT || 'http://host.docker.internal:7800',
  gitlab: process.env.WEBARENA_GITLAB || 'http://host.docker.internal:7810',
  map: process.env.WEBARENA_MAP || 'http://host.docker.internal:7820',
  wikipedia: process.env.WEBARENA_WIKIPEDIA || 'http://host.docker.internal:7830',
}

// ---------------------------------------------------------------------------
// WebArena task type
// ---------------------------------------------------------------------------

interface WebArenaTask {
  task_id: number
  require_login: boolean
  storage_state: string
  start_url: string
  geolocation: string | null
  intent_template: string
  intent: string
  instantiation_dict: Record<string, string>
  require_reset: boolean
  eval: {
    eval_types: string[]
    reference_answers: Record<string, unknown>
    reference_url: string
    program_html: string[]
    url_note?: string
  }
  sites: string[]
}

// ---------------------------------------------------------------------------
// Dataset loader
// ---------------------------------------------------------------------------

function loadTasks(): WebArenaTask[] {
  const jsonPath = resolve(dataDir, 'test.raw.json')

  if (!existsSync(jsonPath)) {
    console.error(`WebArena task file not found: ${jsonPath}`)
    console.error(`\nTo prepare the dataset:`)
    console.error(`  mkdir -p ${dataDir}`)
    console.error(`  git clone https://github.com/web-arena-x/webarena ${resolve(REPO_ROOT, '.webarena/webarena')}`)
    console.error(`  cp ${resolve(REPO_ROOT, '.webarena/webarena/config_files/*.json')} ${dataDir}/`)
    console.error(`\nThen update URLs in test.raw.json to match your docker-compose setup.`)
    process.exit(1)
  }

  const raw = readFileSync(jsonPath, 'utf-8')
  return JSON.parse(raw) as WebArenaTask[]
}

function resolveStartUrl(url: string): string {
  let resolved = url
  for (const [name, siteUrl] of Object.entries(WEBARENA_SITES)) {
    const placeholder = `__PLACEHOLDER_${name.toUpperCase()}__`
    resolved = resolved.replace(placeholder, siteUrl)
    resolved = resolved.replace(`__${name.toUpperCase()}__`, siteUrl)
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Instance result
// ---------------------------------------------------------------------------

interface InstanceResult {
  task_id: number
  intent: string
  sites: string[]
  passed: boolean
  durationS: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCalls: number
  error?: string
  agentResponse?: string
}

// ---------------------------------------------------------------------------
// Run a single task
// ---------------------------------------------------------------------------

async function runTask(
  worker: DockerWorker,
  task: WebArenaTask,
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

  const siteMap: Record<string, string> = {}
  for (const site of task.sites) {
    if (WEBARENA_SITES[site]) siteMap[site] = WEBARENA_SITES[site]
  }

  const startUrl = resolveStartUrl(task.start_url)
  const prompt = buildWebArenaPrompt({
    taskId: task.task_id,
    intent: task.intent,
    startUrl,
    sites: siteMap,
  })

  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: 900_000,
    verbose: verboseFlag,
    workspaceDir: worker.dir,
  }

  console.log(`[${index + 1}/${total}] Task ${task.task_id}: ${task.intent.slice(0, 80)}...`)

  let resp: ParsedAgentResponse
  try {
    const messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }> = [
      { role: 'user', parts: [{ type: 'text', text: prompt }] },
    ]
    resp = await sendTurn(messages, config)
  } catch (err: any) {
    const duration = (Date.now() - startTime) / 1000
    console.log(`[${index + 1}/${total}] ERROR Task ${task.task_id}: ${err.message}`)
    return {
      task_id: task.task_id, intent: task.intent, sites: task.sites,
      passed: false, durationS: duration,
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      toolCalls: 0, error: err.message,
    }
  }

  // Evaluate: run WebArena's evaluator script if available
  let passed = false
  const evalScript = resolve(REPO_ROOT, '.webarena/webarena/evaluation_harness/evaluators.py')
  if (existsSync(evalScript)) {
    try {
      const evalInput = JSON.stringify({
        task: task,
        response: resp.text,
        trajectory: resp.toolCalls.map(tc => ({ action: tc.name, args: tc.input })),
      })
      const evalInputPath = join(tmpdir(), `webarena-eval-${task.task_id}.json`)
      writeFileSync(evalInputPath, evalInput)

      const result = execSync(
        `python3 -c "
import json, sys
sys.path.insert(0, '${resolve(REPO_ROOT, '.webarena/webarena')}')
from evaluation_harness.evaluators import evaluator_router
task = json.load(open('${evalInputPath}'))['task']
evaluator = evaluator_router(task)
score = evaluator(trajectory=None, config_file=task, page=None, client=None)
print(json.dumps({'score': score}))
"`,
        { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim()

      const evalResult = JSON.parse(result)
      passed = evalResult.score >= 1.0
    } catch (err: any) {
      if (verboseFlag) console.log(`      [eval] Evaluator failed: ${err.message}`)
    }
  } else {
    if (verboseFlag) console.log(`      [eval] Evaluator not found at ${evalScript}, marking as unscored`)
  }

  const duration = (Date.now() - startTime) / 1000
  const status = passed ? 'PASS' : 'FAIL'
  console.log(`[${index + 1}/${total}] ${status} Task ${task.task_id} (${duration.toFixed(1)}s, ${resp.toolCalls.length} tools)`)

  return {
    task_id: task.task_id, intent: task.intent, sites: task.sites,
    passed, durationS: duration,
    inputTokens: resp.inputTokens, outputTokens: resp.outputTokens,
    cacheReadTokens: resp.cacheReadTokens, cacheWriteTokens: resp.cacheWriteTokens,
    toolCalls: resp.toolCalls.length,
    agentResponse: resp.text,
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let globalWorkers: DockerWorker[] = []

registerCleanupHandlers(() => globalWorkers, 'webarena-crash.log')

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('WEBARENA BENCHMARK')
  console.log('='.repeat(60))
  console.log(`  Model:     ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Workers:   ${workersArg}`)
  console.log(`  Data:      ${dataDir}`)
  if (domainArg) console.log(`  Domain:    ${domainArg}`)
  console.log('')

  const tasks = loadTasks()
  let filtered = tasks

  if (domainArg) {
    const domains = domainArg.toLowerCase().split(',').map(s => s.trim())
    filtered = filtered.filter(t => t.sites.some(s => domains.includes(s)))
  }
  if (filterArg) {
    const ids = filterArg.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))
    if (ids.length > 0) {
      filtered = filtered.filter(t => ids.includes(t.task_id))
    }
  }

  const siteCounts = new Map<string, number>()
  for (const t of filtered) {
    for (const s of t.sites) siteCounts.set(s, (siteCounts.get(s) || 0) + 1)
  }
  const siteInfo = [...siteCounts.entries()].map(([s, c]) => `${s}:${c}`).join(' ')

  console.log(`  Tasks:     ${filtered.length}`)
  console.log(`  Sites:     ${siteInfo}`)
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
  const partialPath = resolve(tmpdir(), `webarena-partial-${modelArg}-${Date.now()}.json`)

  let nextIndex = 0

  function savePartial() {
    savePartialResults(partialPath, results)
  }

  const workerConfig = evalWorkerConfig({
    image,
    containerPrefix: 'webarena-worker',
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

      await ensureWorkerHealthy(worker, workerId, workerConfig, globalWorkers, (ws) => { globalWorkers = ws }, verboseFlag)

      try {
        const result = await runTask(worker, filtered[idx], idx, filtered.length)
        results[idx] = result
        savePartial()
      } catch (err: any) {
        console.error(`[${idx + 1}/${filtered.length}] CRASH Task ${filtered[idx].task_id}: ${err.message}`)
        results[idx] = {
          task_id: filtered[idx].task_id, intent: filtered[idx].intent,
          sites: filtered[idx].sites,
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
  console.log('WEBARENA RESULTS')
  console.log('='.repeat(60))
  console.log(`  Model:        ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Total:        ${finalResults.length}`)
  console.log(`  Passed:       ${passed} (${(passed / finalResults.length * 100).toFixed(1)}%)`)
  console.log(`  Failed:       ${finalResults.length - passed}`)
  console.log(`  Errors:       ${withError}`)
  console.log('')

  // By domain
  const domains = new Set(finalResults.flatMap(r => r.sites))
  for (const domain of domains) {
    const domainResults = finalResults.filter(r => r.sites.includes(domain))
    const domainPassed = domainResults.filter(r => r.passed).length
    console.log(`  ${domain.padEnd(20)} ${domainPassed}/${domainResults.length} (${(domainPassed / domainResults.length * 100).toFixed(1)}%)`)
  }
  console.log('')

  printCostSummary(cost, totalTime, 'task')

  // Write results
  const resultsPath = resolve(tmpdir(), `webarena-results-${modelArg}-${Date.now()}.json`)
  writeFileSync(resultsPath, JSON.stringify({
    benchmark: 'webarena',
    model: MODEL_MAP[modelArg] || modelArg,
    timestamp: new Date().toISOString(),
    results: finalResults,
    summary: {
      total: finalResults.length, passed, withError,
      successRate: `${(passed / finalResults.length * 100).toFixed(1)}%`,
      totalCost: '$' + cost.totalCost.toFixed(2),
      totalDurationS: Math.round(totalTime),
    },
  }, null, 2))
  console.log(`\nResults saved: ${resultsPath}`)

  cleanupPartialFile(partialPath)
}

main().catch(err => {
  console.error('Fatal:', err)
  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()
  process.exit(1)
})
