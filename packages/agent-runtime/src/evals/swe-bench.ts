#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SWE-bench Benchmark Runner
 *
 * Supports SWE-bench Lite, Full, and Pro (multi-language).
 * When using --dataset pro, downloads from HuggingFace, builds combined
 * Docker images (official SWE-bench + Shogo overlay), and optionally
 * grades results locally via the official evaluation harness.
 *
 * Usage:
 *   bun run src/evals/swe-bench.ts --model haiku --split dev
 *   bun run src/evals/swe-bench.ts --model haiku --split dev --workers 2 --verbose
 *   bun run src/evals/swe-bench.ts --model haiku --split dev --filter django --verbose
 *   bun run src/evals/swe-bench.ts --model haiku --split dev --build
 *   bun run src/evals/swe-bench.ts --model gpt54mini --dataset pro --workers 4
 *   bun run src/evals/swe-bench.ts --model gpt54mini --dataset pro --filter tutanota --grade
 *   bun run src/evals/swe-bench.ts --model gpt54mini --dataset pro --slice 0:20
 *   bun run src/evals/swe-bench.ts --grade-only --predictions <path>
 */

import { execSync } from 'child_process'
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
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

import { sendTurn, type EvalRunnerConfig, type ParsedAgentResponse } from './runner'
import { buildSWEBenchPrompt } from './swe-bench-prompt'
import { loadJsonl, loadCsv, computeCost, printCostSummary, savePartialResults, cleanupPartialFile, printErrorSummary, shogoModelName } from './bench-utils'
import { ensureRepoCache as ensureRepoCacheShared, prepWorkspace as prepWorkspaceShared, extractPatch as extractPatchShared } from './patch-bench-utils'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const modelArg = getArg(args, 'model', 'haiku')!
const splitArg = getArg(args, 'split', 'test')!
const datasetArg = getArg(args, 'dataset', 'lite')! as 'lite' | 'full' | 'pro'
const workersArg = parseInt(getArg(args, 'workers', '1')!)
const filterArg = getArg(args, 'filter')
const sliceArg = getArg(args, 'slice')
const dataDir = getArg(args, 'data', resolve(REPO_ROOT, '.swe-bench/data'))!
const repoCache = getArg(args, 'repos', resolve(REPO_ROOT, '.swe-bench/repos'))!
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')
const gradeFlag = args.includes('--grade')
const gradeOnlyFlag = args.includes('--grade-only')
const noSweImagesFlag = args.includes('--no-swe-images')
const predictionsArg = getArg(args, 'predictions')

const BASE_PORT = 7200
const SWE_OVERLAY_IMAGE = 'shogo-swe-overlay:latest'

// ---------------------------------------------------------------------------
// Instance types
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

interface SWEBenchProInstance extends SWEBenchInstance {
  requirements?: string
  interface?: string
  repo_language?: string
  dockerhub_tag?: string
  issue_specificity?: string
  issue_categories?: string
  before_repo_set_cmd?: string
  selected_test_files_to_run?: string
}

type AnyInstance = SWEBenchInstance | SWEBenchProInstance

function isProInstance(inst: AnyInstance): inst is SWEBenchProInstance {
  return datasetArg === 'pro' && 'dockerhub_tag' in inst
}

// ---------------------------------------------------------------------------
// Dataset loading
// ---------------------------------------------------------------------------

function downloadProDataset(): string {
  mkdirSync(dataDir, { recursive: true })
  const localPath = resolve(dataDir, 'swe-bench-pro-test.csv')
  if (existsSync(localPath)) {
    console.log(`  Pro dataset cached at ${localPath}`)
    return localPath
  }

  console.log('  Downloading SWE-bench Pro dataset from HuggingFace...')
  const url = 'https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro/resolve/main/test.csv'
  try {
    execSync(`curl -fsSL -o "${localPath}" "${url}"`, {
      stdio: 'inherit',
      timeout: 120_000,
    })
    console.log(`  Downloaded to ${localPath}`)
  } catch (err: any) {
    throw new Error(`Failed to download Pro dataset: ${err.message}`)
  }
  return localPath
}

function loadInstances(): AnyInstance[] {
  if (datasetArg === 'pro') {
    const csvPath = downloadProDataset()
    return loadCsv<SWEBenchProInstance>(csvPath)
  }
  const prefix = datasetArg === 'full' ? 'swe-bench' : 'swe-bench-lite'
  const jsonlPath = resolve(dataDir, `${prefix}-${splitArg}.jsonl`)
  return loadJsonl<SWEBenchInstance>(jsonlPath, `Download it first with the HuggingFace API or place it at the expected path.`)
}

// ---------------------------------------------------------------------------
// Docker image management (SWE-bench Pro / official images)
// ---------------------------------------------------------------------------

function getDockerImage(instance: AnyInstance): string | null {
  if (noSweImagesFlag) return null
  if (isProInstance(instance) && instance.dockerhub_tag) {
    return `jefzda/sweap-images:${instance.dockerhub_tag}`
  }
  return null
}

const _builtCombinedImages = new Map<string, string>()

function buildCombinedImage(sweImage: string, instanceId: string): string {
  const cached = _builtCombinedImages.get(sweImage)
  if (cached) return cached

  console.log(`  [docker] Pulling ${sweImage}...`)
  execSync(`docker pull "${sweImage}"`, { stdio: 'pipe', timeout: 600_000 })

  const safeTag = `swe-combined-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase().slice(0, 60)}`

  const dockerfile = [
    `FROM ${sweImage}`,
    `COPY --from=${SWE_OVERLAY_IMAGE} /usr/local/bin/bun /usr/local/bin/bun`,
    `COPY --from=${SWE_OVERLAY_IMAGE} /usr/local/bin/node /usr/local/bin/node`,
    `COPY --from=${SWE_OVERLAY_IMAGE} /usr/bin/rg /usr/bin/rg`,
    `COPY --from=${SWE_OVERLAY_IMAGE} /app /app`,
    `COPY --from=${SWE_OVERLAY_IMAGE} /swe-entrypoint.sh /swe-entrypoint.sh`,
  ].join('\n')

  const tmpDir = resolve(tmpdir(), `swe-build-${safeTag}`)
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(join(tmpDir, 'Dockerfile'), dockerfile)

  console.log(`  [docker] Building combined image ${safeTag}...`)
  const start = Date.now()
  execSync(`docker build -t "${safeTag}" "${tmpDir}"`, {
    stdio: verboseFlag ? 'inherit' : 'pipe',
    timeout: 120_000,
  })
  console.log(`  [docker] Built ${safeTag} in ${((Date.now() - start) / 1000).toFixed(1)}s`)

  _builtCombinedImages.set(sweImage, safeTag)
  return safeTag
}

function extractWorkspaceFromImage(sweImage: string, workspaceDir: string): void {
  const tmpName = `swe-extract-${Date.now()}`
  try {
    execSync(`docker create --name "${tmpName}" "${sweImage}" /bin/true`, { stdio: 'pipe', timeout: 30_000 })

    // SWE-bench uses /testbed for workspace code
    const testbedExists = (() => {
      try {
        execSync(`docker cp "${tmpName}:/testbed/." "${workspaceDir}/"`, { stdio: 'pipe', timeout: 300_000 })
        return true
      } catch { return false }
    })()

    if (!testbedExists) {
      console.warn(`  [extract] /testbed not found in ${sweImage}, trying /app/`)
      execSync(`docker cp "${tmpName}:/app/." "${workspaceDir}/"`, { stdio: 'pipe', timeout: 300_000 })
    }
  } finally {
    try { execSync(`docker rm -f "${tmpName}"`, { stdio: 'pipe' }) } catch {}
  }
}

// ---------------------------------------------------------------------------
// Repo cache — bare clone per unique repo (fallback path)
// ---------------------------------------------------------------------------

function ensureRepoCache(repo: string): string {
  return ensureRepoCacheShared(repo, repoCache)
}

// ---------------------------------------------------------------------------
// Workspace prep — clone repo at base_commit into worker dir (fallback path)
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
  'debug_*.go', 'reproduce_*.go', 'check_*.go',
  'debug_*.ts', 'reproduce_*.ts', 'check_*.ts',
  'debug_*.js', 'reproduce_*.js', 'check_*.js',
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
  usedSweImage?: boolean
}

// ---------------------------------------------------------------------------
// Run a single instance
// ---------------------------------------------------------------------------

async function runInstance(
  worker: DockerWorker,
  instance: AnyInstance,
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

  const promptOpts: Parameters<typeof buildSWEBenchPrompt>[0] = {
    instanceId: instance.instance_id,
    repo: instance.repo,
    problemStatement: instance.problem_statement,
  }
  if (isProInstance(instance)) {
    promptOpts.requirements = instance.requirements
    promptOpts.interface = instance.interface
    promptOpts.repoLanguage = instance.repo_language
  }
  const prompt = buildSWEBenchPrompt(promptOpts)

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
// Local grading (SWE-bench Pro)
// ---------------------------------------------------------------------------

const EVAL_REPO_DIR = resolve(REPO_ROOT, '.swe-bench/SWE-bench_Pro-os')

function ensureEvalRepo(): void {
  if (existsSync(join(EVAL_REPO_DIR, 'swe_bench_pro_eval.py'))) return

  console.log('  Cloning SWE-bench Pro evaluation repo...')
  mkdirSync(resolve(REPO_ROOT, '.swe-bench'), { recursive: true })
  execSync(`git clone https://github.com/scaleapi/SWE-bench_Pro-os.git "${EVAL_REPO_DIR}"`, {
    stdio: 'inherit',
    timeout: 120_000,
  })

  console.log('  Installing eval dependencies...')
  execSync(`pip install -r "${join(EVAL_REPO_DIR, 'requirements.txt')}"`, {
    stdio: 'inherit',
    timeout: 300_000,
  })
}

function gradeResults(predictionsPath: string): void {
  ensureEvalRepo()

  const datasetPath = resolve(dataDir, 'swe-bench-pro-test.csv')
  if (!existsSync(datasetPath)) {
    console.error(`Dataset file not found: ${datasetPath}`)
    return
  }

  // Convert our predictions JSONL to the Pro eval format (JSON array with instance_id + patch)
  const raw = readFileSync(predictionsPath, 'utf-8')
  const predictions = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
  const patches = predictions.map((p: any) => ({
    instance_id: p.instance_id,
    patch: p.model_patch || '',
    prefix: '',
  }))

  const patchesPath = resolve(tmpdir(), `swe-pro-patches-${Date.now()}.json`)
  writeFileSync(patchesPath, JSON.stringify(patches, null, 2))

  const outputDir = resolve(REPO_ROOT, '.swe-bench/grade-results', `grade-${Date.now()}`)
  mkdirSync(outputDir, { recursive: true })

  const scriptsDir = join(EVAL_REPO_DIR, 'run_scripts')
  const evalScript = join(EVAL_REPO_DIR, 'swe_bench_pro_eval.py')
  const numGradeWorkers = Math.min(4, workersArg)

  console.log('')
  console.log('GRADING')
  console.log('-'.repeat(40))
  console.log(`  Patches:  ${patches.length}`)
  console.log(`  Workers:  ${numGradeWorkers}`)
  console.log(`  Output:   ${outputDir}`)
  console.log('')

  try {
    execSync([
      `python "${evalScript}"`,
      `--raw_sample_path="${datasetPath}"`,
      `--patch_path="${patchesPath}"`,
      `--output_dir="${outputDir}"`,
      `--scripts_dir="${scriptsDir}"`,
      `--num_workers=${numGradeWorkers}`,
      `--dockerhub_username=jefzda`,
      `--use_local_docker`,
    ].join(' '), {
      stdio: 'inherit',
      timeout: 7200_000,
    })
  } catch (err: any) {
    console.error(`Grading failed: ${err.message}`)
    return
  }

  // Read and print results
  const evalResultPath = join(outputDir, 'eval_results.json')
  if (existsSync(evalResultPath)) {
    const results = JSON.parse(readFileSync(evalResultPath, 'utf-8'))
    const resolved = results.resolved || []
    const unresolved = results.unresolved || []
    const errors = results.errors || []
    const total = resolved.length + unresolved.length + errors.length

    console.log('')
    console.log('GRADING RESULTS')
    console.log('-'.repeat(40))
    console.log(`  Resolved:     ${resolved.length} / ${total} (${(resolved.length / total * 100).toFixed(1)}%)`)
    console.log(`  Unresolved:   ${unresolved.length}`)
    console.log(`  Errors:       ${errors.length}`)
  } else {
    console.log(`  Results file not found at ${evalResultPath}`)
    console.log(`  Check ${outputDir} for output files`)
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
  // Handle --grade-only mode
  if (gradeOnlyFlag) {
    if (!predictionsArg) {
      console.error('--grade-only requires --predictions <path>')
      process.exit(1)
    }
    gradeResults(predictionsArg)
    return
  }

  const datasetLabel = datasetArg === 'pro' ? 'SWE-BENCH PRO' :
    datasetArg === 'full' ? 'SWE-BENCH' : 'SWE-BENCH LITE'
  const useSweImages = datasetArg === 'pro' && !noSweImagesFlag

  console.log('')
  console.log('='.repeat(60))
  console.log(`${datasetLabel} BENCHMARK (Docker)`)
  console.log('='.repeat(60))
  console.log(`  Model:       ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Dataset:     ${datasetLabel}`)
  console.log(`  Split:       ${splitArg}`)
  console.log(`  Workers:     ${workersArg}`)
  console.log(`  SWE images:  ${useSweImages ? 'yes' : 'no (fallback mode)'}`)
  console.log(`  Grade:       ${gradeFlag ? 'yes' : 'no'}`)
  console.log(`  Data:        ${dataDir}`)
  if (!useSweImages) console.log(`  Repo cache:  ${repoCache}`)
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

  if (sliceArg) {
    const [startStr, endStr] = sliceArg.split(':')
    const start = parseInt(startStr) || 0
    const end = endStr ? parseInt(endStr) : filtered.length
    filtered = filtered.slice(start, end)
  }

  const uniqueRepos = [...new Set(filtered.map(i => i.repo))]
  console.log(`  Instances: ${filtered.length}`)
  console.log(`  Repos:     ${uniqueRepos.length} (${uniqueRepos.join(', ')})`)
  if (datasetArg === 'pro') {
    const langs = [...new Set(filtered.filter(isProInstance).map(i => i.repo_language).filter(Boolean))]
    if (langs.length) console.log(`  Languages: ${langs.join(', ')}`)
  }
  console.log('')

  if (filtered.length === 0) {
    console.log('No instances found')
    process.exit(1)
  }

  // Pre-cache repos (only needed for fallback path)
  if (!useSweImages) {
    console.log('Ensuring repo caches...')
    for (const repo of uniqueRepos) {
      ensureRepoCache(repo)
      console.log(`  ${repo} ✓`)
    }
    console.log('')
  }

  // Ensure overlay image exists (for SWE-bench Pro)
  if (useSweImages) {
    try {
      execSync(`docker image inspect "${SWE_OVERLAY_IMAGE}" > /dev/null 2>&1`, { stdio: 'pipe' })
      console.log(`  Overlay image ${SWE_OVERLAY_IMAGE} found`)
    } catch {
      throw new Error(
        `Overlay image "${SWE_OVERLAY_IMAGE}" not found. Build it first:\n` +
        `  DOCKER_BUILDKIT=1 docker build --platform linux/amd64 -t ${SWE_OVERLAY_IMAGE} -f packages/agent-runtime/Dockerfile.swe-overlay .`,
      )
    }
  }

  // Ensure Docker image exists for fallback path
  if (!useSweImages) {
    const image = DEFAULT_RUNTIME_IMAGE
    await ensureDockerImage(image, { build: buildFlag })
  }

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

  // Base worker config (used for fallback path or as defaults)
  const baseWorkerConfig = evalWorkerConfig({
    image: DEFAULT_RUNTIME_IMAGE,
    containerPrefix: 'swe-bench-worker',
    baseHostPort: BASE_PORT,
    model: modelArg,
    verbose: verboseFlag,
    maxIterations: 200,
    envOverrides: { PIP_BREAK_SYSTEM_PACKAGES: '1' },
    entrypoint: useSweImages
      ? 'bash /swe-entrypoint.sh'
      : 'cd /app/packages/agent-runtime && exec bun run src/server.ts',
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
    const fullOk = dockerPipExec(worker,
      'pip install -e /app/workspace -q 2>&1 | tail -3',
      'editable install', 90_000, 1)
    if (!fullOk) {
      dockerPipExec(worker,
        'pip install --no-deps -e /app/workspace -q 2>&1 | tail -3',
        'editable install (no-deps fallback)', 60_000)
    }

    dockerPipExec(worker,
      'found=0; for f in /app/workspace/requirements*.txt /app/workspace/test-requirements*.txt; do [ -f "$f" ] && pip install -r "$f" -q 2>&1 | tail -1 && found=1; done; [ "$found" = 1 ] || true',
      'requirements', 120_000)

    dockerPipExec(worker,
      'pip install pytest -q 2>&1 | tail -1',
      'pytest', 60_000)
  }

  async function startWorkerForInstance(workerId: number, instance: AnyInstance, maxRetries = 3): Promise<DockerWorker> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const sweImage = getDockerImage(instance)

        if (sweImage) {
          // --- SWE-bench image path ---
          if (verboseFlag) console.log(`      [prep] Building combined image for ${instance.instance_id}...`)

          let combinedTag: string
          try {
            combinedTag = buildCombinedImage(sweImage, instance.instance_id)
          } catch (pullErr: any) {
            console.warn(`  [worker ${workerId}] SWE image not available (${pullErr.message?.slice(0, 80)}), falling back to manual setup`)
            return await startFallbackWorker(workerId, instance)
          }

          // Extract workspace from the SWE-bench image
          const workDir = resolve(REPO_ROOT, '.swe-bench/workspaces', `w${workerId}`)
          const { cleanWorkspaceDir } = await import('./patch-bench-utils')
          cleanWorkspaceDir(workDir)
          mkdirSync(workDir, { recursive: true })

          if (verboseFlag) console.log(`      [prep] Extracting workspace from ${sweImage}...`)
          extractWorkspaceFromImage(sweImage, workDir)

          // Initialize git if not already a repo (needed for patch extraction)
          try {
            execSync('git status', { cwd: workDir, stdio: 'pipe', timeout: 5_000 })
          } catch {
            execSync('git init && git add -A && git commit -m "initial" --allow-empty', {
              cwd: workDir, stdio: 'pipe', timeout: 30_000,
            })
          }

          const worker = await startDockerWorker(workerId, baseWorkerConfig, {
            workspaceDir: workDir,
            imageOverride: combinedTag,
            extraVolumeMounts: [`${workDir}:/testbed`],
          })
          globalWorkers = [...globalWorkers.filter(w => w.id !== workerId), worker]
          return worker
        }

        // --- Fallback path (manual clone + pip install) ---
        return await startFallbackWorker(workerId, instance)
      } catch (err: any) {
        console.warn(`  [worker ${workerId}] Start attempt ${attempt}/${maxRetries} failed: ${err.message}`)
        if (attempt === maxRetries) throw err
        await Bun.sleep(3_000 * attempt)
      }
    }
    throw new Error('unreachable')
  }

  async function startFallbackWorker(workerId: number, instance: AnyInstance): Promise<DockerWorker> {
    if (verboseFlag) console.log(`      [prep] Setting up workspace for ${instance.instance_id} (fallback)...`)
    const workDir = prepWorkspace(workerId, instance)
    const worker = await startDockerWorker(workerId, baseWorkerConfig, { workspaceDir: workDir })
    globalWorkers = [...globalWorkers.filter(w => w.id !== workerId), worker]
    installRepoDeps(worker)
    return worker
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
    `predictions-${datasetArg}-${modelArg}-${splitArg}-${Date.now()}.jsonl`,
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
    `swe-bench-results-${datasetArg}-${modelArg}-${splitArg}-${Date.now()}.json`,
  )
  writeFileSync(detailedPath, JSON.stringify({
    benchmark: `swe-bench-${datasetArg}`,
    model: MODEL_MAP[modelArg] || modelArg,
    dataset: datasetArg,
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

  // Auto-grade if --grade was passed (Pro only)
  if (gradeFlag && datasetArg === 'pro') {
    console.log('')
    gradeResults(predictionsPath)
  } else if (gradeFlag && datasetArg !== 'pro') {
    console.log('')
    console.log('Note: --grade is only supported for --dataset pro. For Lite/Full, use:')
    console.log(`  python -m swebench.harness.run_evaluation \\`)
    console.log(`    --dataset_name princeton-nlp/SWE-bench_Lite \\`)
    console.log(`    --predictions_path "${predictionsPath}" \\`)
    console.log(`    --max_workers 4 --run_id ${modelName} --split ${splitArg}`)
  } else if (datasetArg !== 'pro') {
    console.log('')
    console.log('Next step: evaluate predictions with the SWE-bench harness:')
    console.log(`  python -m swebench.harness.run_evaluation \\`)
    console.log(`    --dataset_name princeton-nlp/SWE-bench_Lite \\`)
    console.log(`    --predictions_path "${predictionsPath}" \\`)
    console.log(`    --max_workers 4 --run_id ${modelName} --split ${splitArg}`)
  }

  cleanupPartialFile(partialPath)
}

main().catch(err => {
  console.error('Fatal:', err)
  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()
  process.exit(1)
})
