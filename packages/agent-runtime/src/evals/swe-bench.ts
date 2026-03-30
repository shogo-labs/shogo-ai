#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SWE-bench Lite Benchmark Runner
 *
 * Downloads SWE-bench Lite instances, checks out each repo at the right
 * commit, lets the Shogo agent solve the GitHub issue, then extracts a
 * git diff patch for grading by the official SWE-bench evaluation harness.
 *
 * Usage:
 *   bun run src/evals/swe-bench.ts --model haiku --split dev
 *   bun run src/evals/swe-bench.ts --model haiku --split dev --workers 2 --verbose
 *   bun run src/evals/swe-bench.ts --model haiku --split dev --filter django --verbose
 *   bun run src/evals/swe-bench.ts --model haiku --split dev --build
 *   bun run src/evals/swe-bench.ts --model gpt54mini --split dev --dataset full --workers 4
 */

import { execSync } from 'child_process'
import { writeFileSync, appendFileSync } from 'fs'
import { resolve } from 'path'
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

import { sendTurn, type EvalRunnerConfig, type ParsedAgentResponse } from './runner'
import { buildSWEBenchPrompt } from './swe-bench-prompt'
import { loadJsonl, computeCost, printCostSummary, savePartialResults, cleanupPartialFile, printErrorSummary, shogoModelName } from './bench-utils'
import { ensureRepoCache as ensureRepoCacheShared, prepWorkspace as prepWorkspaceShared, extractPatch as extractPatchShared } from './patch-bench-utils'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const modelArg = getArg(args, 'model', 'haiku')!
const splitArg = getArg(args, 'split', 'dev')!
const datasetArg = getArg(args, 'dataset', 'lite')!  // 'lite' or 'full'
const workersArg = parseInt(getArg(args, 'workers', '1')!)
const filterArg = getArg(args, 'filter')
const dataDir = getArg(args, 'data', resolve(REPO_ROOT, '.swe-bench/data'))!
const repoCache = getArg(args, 'repos', resolve(REPO_ROOT, '.swe-bench/repos'))!
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')

const BASE_PORT = 7200

// ---------------------------------------------------------------------------
// SWE-bench instance type
// ---------------------------------------------------------------------------

interface SWEBenchInstance {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  hints_text: string
  version: string
  patch: string
  test_patch: string
  FAIL_TO_PASS: string
  PASS_TO_PASS: string
}

// ---------------------------------------------------------------------------
// Dataset loader
// ---------------------------------------------------------------------------

function loadInstances(): SWEBenchInstance[] {
  const prefix = datasetArg === 'full' ? 'swe-bench' : 'swe-bench-lite'
  const jsonlPath = resolve(dataDir, `${prefix}-${splitArg}.jsonl`)
  return loadJsonl<SWEBenchInstance>(jsonlPath, `Download it first with the HuggingFace API or place it at the expected path.`)
}

// ---------------------------------------------------------------------------
// Repo cache — bare clone per unique repo
// ---------------------------------------------------------------------------

function ensureRepoCache(repo: string): string {
  return ensureRepoCacheShared(repo, repoCache)
}

// ---------------------------------------------------------------------------
// Workspace prep — clone repo at base_commit into worker dir
// ---------------------------------------------------------------------------

function prepWorkspace(workerId: number, instance: SWEBenchInstance): string {
  return prepWorkspaceShared({
    workerId,
    repo: instance.repo,
    baseCommit: instance.base_commit,
    repoCache,
    workspaceRoot: resolve(REPO_ROOT, '.swe-bench/workspaces'),
    verbose: verboseFlag,
  })
}

// ---------------------------------------------------------------------------
// Patch extraction — git diff after agent edits
// ---------------------------------------------------------------------------

const JUNK_FILE_PATTERNS = [
  'debug_*.py', 'test_*.py', 'reproduce_*.py', 'check_*.py',
  'verify_*.py', 'tmp_*.py', 'temp_*.py',
]

function extractPatch(repoDir: string): string {
  return extractPatchShared(repoDir, { junkPatterns: JUNK_FILE_PATTERNS })
}

// ---------------------------------------------------------------------------
// Instance result
// ---------------------------------------------------------------------------

interface InstanceResult {
  instance_id: string
  repo: string
  model_patch: string
  durationS: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCalls: number
  error?: string
}

// ---------------------------------------------------------------------------
// Run a single instance
// ---------------------------------------------------------------------------

async function runInstance(
  worker: DockerWorker,
  instance: SWEBenchInstance,
  index: number,
  total: number,
): Promise<InstanceResult> {
  const startTime = Date.now()

  try { Bun.gc(true) } catch {}

  await configureWorkerForTask(worker, {
    model: modelArg,
    mode: 'none',
    promptProfile: 'swe',
    evalLabel: undefined,
    verbose: verboseFlag,
  })

  // Session reset without evalLabel
  try {
    await fetch(`http://localhost:${worker.port}/agent/session/reset`, { method: 'POST' })
  } catch {}

  const prompt = buildSWEBenchPrompt({
    instanceId: instance.instance_id,
    repo: instance.repo,
    problemStatement: instance.problem_statement,
  })

  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: 600_000,
    verbose: verboseFlag,
    workspaceDir: worker.dir,
  }

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0
  let totalToolCalls = 0

  console.log(`[${index + 1}/${total}] ${instance.instance_id} ...`)
  const messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }> = [
    { role: 'user', parts: [{ type: 'text', text: prompt }] },
  ]

  let resp: ParsedAgentResponse
  try {
    resp = await sendTurn(messages, config)
    totalInput += resp.inputTokens
    totalOutput += resp.outputTokens
    totalCacheRead += resp.cacheReadTokens
    totalCacheWrite += resp.cacheWriteTokens
    totalToolCalls += resp.toolCalls.length
  } catch (err: any) {
    const duration = (Date.now() - startTime) / 1000
    console.log(`[${index + 1}/${total}] ERROR ${instance.instance_id}: ${err.message}`)
    return {
      instance_id: instance.instance_id, repo: instance.repo, model_patch: '',
      durationS: duration, inputTokens: totalInput, outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
      toolCalls: totalToolCalls, error: err.message,
    }
  }

  if (verboseFlag) {
    console.log(`      [agent] ${resp.toolCalls.length} tool calls, ${resp.stepCount} steps`)
  }

  const patch = extractPatch(worker.dir)
  const duration = (Date.now() - startTime) / 1000
  const status = patch ? 'PATCH' : 'EMPTY'
  console.log(`[${index + 1}/${total}] ${status} ${instance.instance_id} (${duration.toFixed(1)}s, ${patch.split('\n').length} lines)`)

  return {
    instance_id: instance.instance_id, repo: instance.repo, model_patch: patch,
    durationS: duration, inputTokens: totalInput, outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
    toolCalls: totalToolCalls,
  }
}

// ---------------------------------------------------------------------------
// Cleanup & signal handling
// ---------------------------------------------------------------------------

let globalWorkers: DockerWorker[] = []

registerCleanupHandlers(() => globalWorkers, 'swe-bench-crash.log')

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  const datasetLabel = datasetArg === 'full' ? 'SWE-BENCH' : 'SWE-BENCH LITE'
  console.log(`${datasetLabel} BENCHMARK (Docker)`)
  console.log('='.repeat(60))
  console.log(`  Model:     ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Dataset:   ${datasetLabel}`)
  console.log(`  Split:     ${splitArg}`)
  console.log(`  Workers:   ${workersArg}`)
  console.log(`  Data:      ${dataDir}`)
  console.log(`  Repo cache:${repoCache}`)
  console.log('')

  const instances = loadInstances()
  let filtered = instances
  if (filterArg) {
    const patterns = filterArg.toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    filtered = instances.filter(i => {
      const id = i.instance_id.toLowerCase()
      return patterns.some(p => id.includes(p))
    })
  }

  const uniqueRepos = [...new Set(filtered.map(i => i.repo))]
  console.log(`  Instances: ${filtered.length}`)
  console.log(`  Repos:     ${uniqueRepos.length} (${uniqueRepos.join(', ')})`)
  console.log('')

  if (filtered.length === 0) {
    console.log('No instances found')
    process.exit(1)
  }

  // Pre-cache repos
  console.log('Ensuring repo caches...')
  for (const repo of uniqueRepos) {
    ensureRepoCache(repo)
    console.log(`  ${repo} ✓`)
  }
  console.log('')

  // Ensure Docker image exists (or build it)
  const image = DEFAULT_RUNTIME_IMAGE
  await ensureDockerImage(image, { build: buildFlag })

  // Write env file once for all workers
  writeDockerEnvFile()

  const numWorkers = Math.min(workersArg, filtered.length)

  console.log('')
  console.log('Running benchmark...')
  console.log('-'.repeat(60))

  const overallStart = Date.now()
  const results: InstanceResult[] = new Array(filtered.length)
  const partialPath = resolve(tmpdir(), `swe-bench-partial-${modelArg}-${Date.now()}.json`)

  let nextIndex = 0
  let completed = 0

  function savePartial() {
    savePartialResults(partialPath, results)
  }

  const workerConfig = evalWorkerConfig({
    image,
    containerPrefix: 'swe-bench-worker',
    baseHostPort: BASE_PORT,
    model: modelArg,
    verbose: verboseFlag,
    maxIterations: 200,
    envOverrides: { PIP_BREAK_SYSTEM_PACKAGES: '1' },
    entrypoint: 'cd /app/packages/agent-runtime && exec bun run src/server.ts',
  })

  function dockerPipExec(worker: DockerWorker, script: string, label: string, timeoutMs = 120_000, retries = 2): boolean {
    const cmd = `docker exec -u root -e PIP_BREAK_SYSTEM_PACKAGES=1 "${worker.containerName}" bash -c 'set -o pipefail; ${script}'`
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const out = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: timeoutMs }).trim()
        if (verboseFlag && out) {
          const last = out.split('\n').pop()
          if (last) console.log(`      [deps] ${label}: ${last}`)
        }
        return true
      } catch (err: any) {
        const msg = err.message?.slice(0, 120) || 'unknown'
        if (attempt < retries) {
          if (verboseFlag) console.warn(`      [deps] ${label} attempt ${attempt} failed, retrying: ${msg}`)
        } else {
          console.warn(`      [deps] ${label} failed (non-fatal): ${msg}`)
        }
      }
    }
    return false
  }

  function installRepoDeps(worker: DockerWorker): void {
    // 1. Try full editable install first (gets all deps); fall back to --no-deps if it OOMs/times out
    const fullOk = dockerPipExec(worker,
      'pip install -e /app/workspace -q 2>&1 | tail -3',
      'editable install', 90_000, 1)
    if (!fullOk) {
      dockerPipExec(worker,
        'pip install --no-deps -e /app/workspace -q 2>&1 | tail -3',
        'editable install (no-deps fallback)', 60_000)
    }

    // 2. Install requirements files (lighter, more critical for test runs)
    dockerPipExec(worker,
      'found=0; for f in /app/workspace/requirements*.txt /app/workspace/test-requirements*.txt; do [ -f "$f" ] && pip install -r "$f" -q 2>&1 | tail -1 && found=1; done; [ "$found" = 1 ] || true',
      'requirements', 120_000)

    // 3. Ensure pytest is available
    dockerPipExec(worker,
      'pip install pytest -q 2>&1 | tail -1',
      'pytest', 60_000)
  }

  async function startWorkerForInstance(workerId: number, instance: SWEBenchInstance, maxRetries = 3): Promise<DockerWorker> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (verboseFlag) console.log(`      [prep] Setting up workspace for ${instance.instance_id}...`)
        const workDir = prepWorkspace(workerId, instance)
        const worker = await startDockerWorker(workerId, workerConfig, { workspaceDir: workDir })
        globalWorkers = [...globalWorkers.filter(w => w.id !== workerId), worker]
        installRepoDeps(worker)
        return worker
      } catch (err: any) {
        console.warn(`  [worker ${workerId}] Start attempt ${attempt}/${maxRetries} failed: ${err.message}`)
        if (attempt === maxRetries) throw err
        await Bun.sleep(3_000 * attempt)
      }
    }
    throw new Error('unreachable')
  }

  async function workerLoop(workerId: number) {
    while (true) {
      const idx = nextIndex++
      if (idx >= filtered.length) break

      const instance = filtered[idx]

      let worker: DockerWorker
      try {
        worker = await startWorkerForInstance(workerId, instance)
      } catch (err: any) {
        console.error(`  [worker ${workerId}] Failed to start for ${instance.instance_id}: ${err.message}`)
        results[idx] = {
          instance_id: instance.instance_id, repo: instance.repo, model_patch: '',
          durationS: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0,
          error: `Worker start failed: ${err.message}`,
        }
        completed++
        savePartial()
        continue
      }

      try {
        const result = await runInstance(worker, instance, idx, filtered.length)
        results[idx] = result
        completed++
        savePartial()
      } catch (err: any) {
        console.error(`[${idx + 1}/${filtered.length}] CRASH ${instance.instance_id}: ${err.message}`)
        results[idx] = {
          instance_id: instance.instance_id, repo: instance.repo, model_patch: '',
          durationS: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0,
          error: err.message,
        }
        completed++
        savePartial()
      } finally {
        stopDockerWorker(worker)
      }
    }
  }

  console.log(`Starting ${numWorkers} concurrent worker loop(s)...`)
  console.log('')
  await Promise.all(Array.from({ length: numWorkers }, (_, i) => workerLoop(i)))

  const totalTime = (Date.now() - overallStart) / 1000

  // Stop workers
  console.log('')
  console.log('Stopping workers...')
  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()

  // ---------------------------------------------------------------------------
  // Summary & predictions output
  // ---------------------------------------------------------------------------

  const finalResults = results.filter(Boolean)
  const withPatch = finalResults.filter(r => r.model_patch.length > 0).length
  const withError = finalResults.filter(r => r.error).length

  const cost = computeCost(finalResults, modelArg)

  console.log('')
  console.log('='.repeat(60))
  console.log(`${datasetLabel} RESULTS`)
  console.log('='.repeat(60))
  console.log(`  Model:        ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Dataset:      ${datasetLabel}`)
  console.log(`  Split:        ${splitArg}`)
  console.log(`  Workers:      ${numWorkers}`)
  console.log(`  Total:        ${finalResults.length}`)
  console.log(`  With patch:   ${withPatch} (${(withPatch / finalResults.length * 100).toFixed(1)}%)`)
  console.log(`  Empty/error:  ${finalResults.length - withPatch}`)
  console.log(`  Errors:       ${withError}`)
  console.log('')

  printCostSummary(cost, totalTime)
  console.log('')

  // Write predictions JSONL (SWE-bench format)
  const predictionsPath = resolve(
    dataDir,
    `predictions-${modelArg}-${splitArg}-${Date.now()}.jsonl`,
  )
  const modelName = shogoModelName(modelArg)
  for (const r of finalResults) {
    const prediction = {
      instance_id: r.instance_id,
      model_name_or_path: modelName,
      model_patch: r.model_patch || '',
    }
    appendFileSync(predictionsPath, JSON.stringify(prediction) + '\n')
  }
  console.log(`Predictions saved to: ${predictionsPath}`)

  // Write detailed results JSON
  const detailedPath = resolve(
    tmpdir(),
    `swe-bench-results-${modelArg}-${splitArg}-${Date.now()}.json`,
  )
  writeFileSync(detailedPath, JSON.stringify({
    benchmark: 'swe-bench-lite',
    model: MODEL_MAP[modelArg] || modelArg,
    split: splitArg,
    timestamp: new Date().toISOString(),
    results: finalResults,
    summary: {
      total: finalResults.length,
      withPatch, withError,
      totalCost: '$' + cost.totalCost.toFixed(2),
      totalDurationS: Math.round(totalTime),
    },
  }, null, 2))
  console.log(`Detailed results saved to: ${detailedPath}`)

  printErrorSummary(finalResults.filter(r => r.error).map(r => ({ id: r.instance_id, error: r.error! })))

  console.log('')
  console.log('Next step: evaluate predictions with the SWE-bench harness:')
  console.log(`  python -m swebench.harness.run_evaluation \\`)
  console.log(`    --dataset_name princeton-nlp/SWE-bench_Lite \\`)
  console.log(`    --predictions_path "${predictionsPath}" \\`)
  console.log(`    --max_workers 4 --run_id ${modelName} --split ${splitArg}`)

  cleanupPartialFile(partialPath)
}

main().catch(err => {
  console.error('Fatal:', err)
  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()
  process.exit(1)
})
