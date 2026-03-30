#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FeatureBench Benchmark Runner
 *
 * Evaluates the Shogo agent on end-to-end feature development tasks.
 * Very similar to the SWE-bench runner but for feature implementation
 * instead of bug fixing.
 *
 * Loads FeatureBench instances, checks out each repo at the base commit,
 * lets the agent implement the feature, extracts a git diff patch, and
 * exports predictions for grading by the `fb eval` harness.
 *
 * Prerequisites:
 *   pip install featurebench
 *   fb data --split lite  # download dataset
 *
 * Usage:
 *   bun run src/evals/feature-bench.ts --model haiku --split lite
 *   bun run src/evals/feature-bench.ts --model sonnet --split lite --workers 2 --verbose
 *   bun run src/evals/feature-bench.ts --model haiku --split lite --filter "repo_name" --verbose
 *   bun run src/evals/feature-bench.ts --model haiku --split lite --build
 */

import {
  writeFileSync,
  appendFileSync,
} from 'fs'
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

import { loadJsonl, computeCost, printCostSummary, savePartialResults, cleanupPartialFile, printErrorSummary, shogoModelName } from './bench-utils'
import { ensureRepoCache as ensureRepoCacheShared, prepWorkspace as prepWorkspaceShared, extractPatch as extractPatchShared } from './patch-bench-utils'

import { sendTurn, type EvalRunnerConfig, type ParsedAgentResponse } from './runner'
import { buildFeatureBenchPrompt } from './feature-bench-prompt'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const modelArg = getArg(args, 'model', 'haiku')!
const splitArg = getArg(args, 'split', 'lite')!
const workersArg = parseInt(getArg(args, 'workers', '1')!)
const filterArg = getArg(args, 'filter')
const dataDir = getArg(args, 'data', resolve(REPO_ROOT, '.feature-bench/data'))!
const repoCache = getArg(args, 'repos', resolve(REPO_ROOT, '.feature-bench/repos'))!
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')

const BASE_PORT = 7100

// ---------------------------------------------------------------------------
// FeatureBench instance type
// ---------------------------------------------------------------------------

interface FeatureBenchInstance {
  instance_id: string
  repo: string
  base_commit: string
  feature_description: string
  hints_text?: string
  version?: string
  patch?: string
  test_patch?: string
  FAIL_TO_PASS: string
  PASS_TO_PASS: string
}

// ---------------------------------------------------------------------------
// Dataset loader
// ---------------------------------------------------------------------------

function loadInstances(): FeatureBenchInstance[] {
  const jsonlPath = resolve(dataDir, `feature-bench-${splitArg}.jsonl`)
  return loadJsonl<FeatureBenchInstance>(jsonlPath,
    `\nTo prepare the dataset:\n` +
    `  pip install featurebench\n` +
    `  fb data --split ${splitArg}\n` +
    `  # Or download manually and place JSONL at: ${jsonlPath}\n` +
    `\nExpected format: one JSON object per line with fields:\n` +
    `  instance_id, repo, base_commit, feature_description, FAIL_TO_PASS, PASS_TO_PASS`,
  )
}

// ---------------------------------------------------------------------------
// Repo cache (same pattern as SWE-bench)
// ---------------------------------------------------------------------------

function ensureRepoCache(repo: string): string {
  return ensureRepoCacheShared(repo, repoCache)
}

// ---------------------------------------------------------------------------
// Workspace prep (same pattern as SWE-bench)
// ---------------------------------------------------------------------------

function prepWorkspace(workerId: number, instance: FeatureBenchInstance): string {
  return prepWorkspaceShared({
    workerId,
    repo: instance.repo,
    baseCommit: instance.base_commit,
    repoCache,
    workspaceRoot: resolve(REPO_ROOT, '.feature-bench/workspaces'),
    verbose: verboseFlag,
  })
}

// ---------------------------------------------------------------------------
// Patch extraction (same as SWE-bench)
// ---------------------------------------------------------------------------

function extractPatch(repoDir: string): string {
  return extractPatchShared(repoDir)
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
  instance: FeatureBenchInstance,
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

  try {
    await fetch(`http://localhost:${worker.port}/agent/session/reset`, { method: 'POST' })
  } catch {}

  const prompt = buildFeatureBenchPrompt({
    instanceId: instance.instance_id,
    repo: instance.repo,
    featureDescription: instance.feature_description,
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
// Cleanup
// ---------------------------------------------------------------------------

let globalWorkers: DockerWorker[] = []

registerCleanupHandlers(() => globalWorkers, 'feature-bench-crash.log')

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('FEATUREBENCH BENCHMARK')
  console.log('='.repeat(60))
  console.log(`  Model:     ${MODEL_MAP[modelArg] || modelArg}`)
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

  const image = DEFAULT_RUNTIME_IMAGE
  await ensureDockerImage(image, { build: buildFlag })
  writeDockerEnvFile()

  const numWorkers = Math.min(workersArg, filtered.length)

  console.log('Running benchmark...')
  console.log('-'.repeat(60))

  const overallStart = Date.now()
  const results: InstanceResult[] = new Array(filtered.length)
  const partialPath = resolve(tmpdir(), `feature-bench-partial-${modelArg}-${Date.now()}.json`)

  let nextIndex = 0

  function savePartial() {
    savePartialResults(partialPath, results)
  }

  const workerConfig = evalWorkerConfig({
    image,
    containerPrefix: 'feature-bench-worker',
    baseHostPort: BASE_PORT,
    model: modelArg,
    verbose: verboseFlag,
    maxIterations: 200,
    entrypoint: 'cd /app/packages/agent-runtime && exec bun run src/server.ts',
  })

  async function startWorkerForInstance(workerId: number, instance: FeatureBenchInstance, maxRetries = 3): Promise<DockerWorker> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (verboseFlag) console.log(`      [prep] Setting up workspace for ${instance.instance_id}...`)
        const workDir = prepWorkspace(workerId, instance)
        const worker = await startDockerWorker(workerId, workerConfig, { workspaceDir: workDir })
        globalWorkers = [...globalWorkers.filter(w => w.id !== workerId), worker]
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
        savePartial()
        continue
      }

      try {
        const result = await runInstance(worker, instance, idx, filtered.length)
        results[idx] = result
        savePartial()
      } catch (err: any) {
        console.error(`[${idx + 1}/${filtered.length}] CRASH ${instance.instance_id}: ${err.message}`)
        results[idx] = {
          instance_id: instance.instance_id, repo: instance.repo, model_patch: '',
          durationS: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0,
          error: err.message,
        }
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

  console.log('')
  console.log('Stopping workers...')
  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const finalResults = results.filter(Boolean)
  const withPatch = finalResults.filter(r => r.model_patch.length > 0).length
  const withError = finalResults.filter(r => r.error).length

  console.log('')
  console.log('='.repeat(60))
  console.log('FEATUREBENCH RESULTS')
  console.log('='.repeat(60))
  console.log(`  Model:        ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Split:        ${splitArg}`)
  console.log(`  Workers:      ${numWorkers}`)
  console.log(`  Total:        ${finalResults.length}`)
  console.log(`  With patch:   ${withPatch} (${(withPatch / finalResults.length * 100).toFixed(1)}%)`)
  console.log(`  Empty/error:  ${finalResults.length - withPatch}`)
  console.log(`  Errors:       ${withError}`)
  console.log('')

  const cost = computeCost(finalResults, modelArg)

  printCostSummary(cost, totalTime)
  console.log('')

  // Write predictions JSONL (FeatureBench format)
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

  // Write detailed results
  const detailedPath = resolve(
    tmpdir(),
    `feature-bench-results-${modelArg}-${splitArg}-${Date.now()}.json`,
  )
  writeFileSync(detailedPath, JSON.stringify({
    benchmark: 'feature-bench',
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
  console.log('Next step: evaluate predictions with FeatureBench harness:')
  console.log(`  fb eval -p "${predictionsPath}" --split ${splitArg}`)

  cleanupPartialFile(partialPath)
}

main().catch(err => {
  console.error('Fatal:', err)
  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()
  process.exit(1)
})
