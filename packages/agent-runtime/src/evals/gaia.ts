#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GAIA Benchmark Runner
 *
 * Loads GAIA dataset instances, sends each question to the Shogo agent,
 * extracts the final answer, and scores with exact-match against gold labels.
 *
 * Dataset: HuggingFace `gaia-benchmark/GAIA` (Parquet → JSONL export)
 * Download with: huggingface-cli download gaia-benchmark/GAIA --repo-type dataset
 *
 * Usage:
 *   bun run src/evals/gaia.ts --model haiku --split validation
 *   bun run src/evals/gaia.ts --model sonnet --split validation --level 1 --workers 2
 *   bun run src/evals/gaia.ts --model haiku --split validation --filter "task_id_prefix" --verbose
 *   bun run src/evals/gaia.ts --model haiku --split validation --build
 */

import { execSync } from 'child_process'
import {
  mkdirSync, existsSync, writeFileSync,
  appendFileSync, cpSync, readdirSync, statSync,
} from 'fs'
import { resolve, join, basename } from 'path'
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

import { loadJsonl, computeCost, printCostSummary, savePartialResults, cleanupPartialFile, printErrorSummary, ensureWorkerHealthy, shogoModelName } from './bench-utils'
import { sendTurn, type EvalRunnerConfig, type ParsedAgentResponse } from './runner'
import { buildGAIAPrompt } from './gaia-prompt'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const modelArg = getArg(args, 'model', 'haiku')!
const splitArg = getArg(args, 'split', 'validation')!
const levelArg = getArg(args, 'level')
const workersArg = parseInt(getArg(args, 'workers', '1')!)
const filterArg = getArg(args, 'filter')
const dataDir = getArg(args, 'data', resolve(REPO_ROOT, '.gaia/data'))!
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')

const BASE_PORT = 7400

// ---------------------------------------------------------------------------
// GAIA instance type
// ---------------------------------------------------------------------------

interface GAIAInstance {
  task_id: string
  Question: string
  Level: number
  'Final answer': string
  file_name: string
  file_path: string
  'Annotator Metadata'?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Dataset loader
// ---------------------------------------------------------------------------

function loadInstances(): GAIAInstance[] {
  const jsonlPath = resolve(dataDir, `gaia-${splitArg}.jsonl`)
  return loadJsonl<GAIAInstance>(jsonlPath,
    `\nTo prepare the dataset:\n` +
    `  1. pip install huggingface_hub datasets\n` +
    `  2. huggingface-cli download gaia-benchmark/GAIA --repo-type dataset --local-dir ${dataDir}\n` +
    `  3. Convert Parquet to JSONL:\n` +
    `     python -c "from datasets import load_dataset; ds = load_dataset('${dataDir}', '2023_all', split='${splitArg}'); [print(json.dumps(dict(r))) for r in ds]" > ${jsonlPath}\n` +
    `\nOr place a JSONL file at: ${jsonlPath}`,
  )
}

// ---------------------------------------------------------------------------
// Answer extraction and scoring
// ---------------------------------------------------------------------------

function extractFinalAnswer(text: string): string {
  const patterns = [
    /FINAL ANSWER:\s*(.+)/i,
    /\*\*FINAL ANSWER\*\*:\s*(.+)/i,
    /Final Answer:\s*(.+)/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[1].trim()
  }

  const lines = text.trim().split('\n').filter(l => l.trim())
  return lines[lines.length - 1]?.trim() || ''
}

function normalizeAnswer(answer: string): string {
  let normalized = answer
    .trim()
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^`+|`+$/g, '')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/\.$/, '')
    .replace(/\s+/g, ' ')
    .trim()

  const num = parseFloat(normalized)
  if (!isNaN(num) && normalized === String(num)) {
    normalized = String(num)
  }

  return normalized
}

function scoreAnswer(predicted: string, gold: string): boolean {
  const normPred = normalizeAnswer(predicted)
  const normGold = normalizeAnswer(gold)

  if (normPred === normGold) return true

  if (normGold.includes(',')) {
    const goldItems = normGold.split(',').map(s => s.trim()).sort()
    const predItems = normPred.split(',').map(s => s.trim()).sort()
    if (goldItems.length === predItems.length && goldItems.every((g, i) => g === predItems[i])) {
      return true
    }
  }

  const goldNum = parseFloat(normGold)
  const predNum = parseFloat(normPred)
  if (!isNaN(goldNum) && !isNaN(predNum)) {
    if (Math.abs(goldNum - predNum) < 1e-6) return true
    if (goldNum !== 0 && Math.abs((goldNum - predNum) / goldNum) < 0.001) return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Instance result
// ---------------------------------------------------------------------------

interface InstanceResult {
  task_id: string
  level: number
  predicted_answer: string
  gold_answer: string
  correct: boolean
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
  instance: GAIAInstance,
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

  let attachmentPath: string | undefined
  const hasAttachment = Boolean(instance.file_name && instance.file_path)
  if (hasAttachment) {
    const srcFile = resolve(dataDir, instance.file_path)
    if (existsSync(srcFile)) {
      const destFile = join(worker.dir, instance.file_name)
      cpSync(srcFile, destFile)
      attachmentPath = instance.file_name
    }
  }

  const prompt = buildGAIAPrompt({
    taskId: instance.task_id,
    question: instance.Question,
    level: instance.Level,
    hasAttachment,
    attachmentPath,
  })

  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: 600_000,
    verbose: verboseFlag,
    workspaceDir: worker.dir,
  }

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0
  let totalToolCalls = 0

  const skillsDir = join(worker.dir, '.shogo', 'skills')
  const skillsBefore = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter(e => {
        try { return statSync(join(skillsDir, e)).isDirectory() } catch { return false }
      })
    : []
  const skillNote = skillsBefore.length > 0 ? ` [skills: ${skillsBefore.join(', ')}]` : ''
  console.log(`[${index + 1}/${total}] L${instance.Level} ${instance.task_id} ...${skillNote}`)
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
    console.log(`[${index + 1}/${total}] ERROR ${instance.task_id}: ${err.message}`)
    return {
      task_id: instance.task_id, level: instance.Level,
      predicted_answer: '', gold_answer: instance['Final answer'],
      correct: false, durationS: duration,
      inputTokens: totalInput, outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
      toolCalls: totalToolCalls, error: err.message,
    }
  }

  const predictedAnswer = extractFinalAnswer(resp.text)
  const goldAnswer = instance['Final answer']
  const correct = scoreAnswer(predictedAnswer, goldAnswer)

  const skillsAfter = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter(e => {
        try { return statSync(join(skillsDir, e)).isDirectory() } catch { return false }
      })
    : []
  const newSkills = skillsAfter.filter(s => !skillsBefore.includes(s))

  const duration = (Date.now() - startTime) / 1000
  const status = correct ? 'CORRECT' : 'WRONG'
  const evolveNote = newSkills.length > 0 ? ` [new skills: ${newSkills.join(', ')}]` : ''
  console.log(`[${index + 1}/${total}] ${status} L${instance.Level} ${instance.task_id} (${duration.toFixed(1)}s) predicted="${predictedAnswer}" gold="${goldAnswer}"${evolveNote}`)

  return {
    task_id: instance.task_id, level: instance.Level,
    predicted_answer: predictedAnswer, gold_answer: goldAnswer,
    correct, durationS: duration,
    inputTokens: totalInput, outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
    toolCalls: totalToolCalls,
  }
}

// ---------------------------------------------------------------------------
// Cleanup & signal handling
// ---------------------------------------------------------------------------

let globalWorkers: DockerWorker[] = []

registerCleanupHandlers(() => globalWorkers, 'gaia-crash.log')

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('GAIA BENCHMARK')
  console.log('='.repeat(60))
  console.log(`  Model:     ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Split:     ${splitArg}`)
  console.log(`  Workers:   ${workersArg}`)
  console.log(`  Data:      ${dataDir}`)
  if (levelArg) console.log(`  Level:     ${levelArg}`)
  console.log('')

  const instances = loadInstances()
  let filtered = instances

  if (levelArg) {
    const level = parseInt(levelArg)
    filtered = filtered.filter(i => Number(i.Level) === level)
  }
  if (filterArg) {
    const patterns = filterArg.toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    filtered = filtered.filter(i => {
      const id = i.task_id.toLowerCase()
      return patterns.some(p => id.includes(p))
    })
  }

  console.log(`  Instances: ${filtered.length}`)
  const levelCounts = [1, 2, 3].map(l => `L${l}:${filtered.filter(i => i.Level === l).length}`)
  console.log(`  Levels:    ${levelCounts.join(' ')}`)
  console.log('')

  if (filtered.length === 0) {
    console.log('No instances found')
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
  const partialPath = resolve(tmpdir(), `gaia-partial-${modelArg}-${Date.now()}.json`)

  let nextIndex = 0

  function savePartial() {
    savePartialResults(partialPath, results)
  }

  const workerConfig = evalWorkerConfig({
    image,
    containerPrefix: 'gaia-worker',
    baseHostPort: BASE_PORT,
    model: modelArg,
    verbose: verboseFlag,
  })

  async function workerLoop(workerId: number) {
    const worker = await startDockerWorker(workerId, workerConfig)
    globalWorkers = [...globalWorkers.filter(w => w.id !== workerId), worker]

    while (true) {
      const idx = nextIndex++
      if (idx >= filtered.length) break

      await ensureWorkerHealthy(worker, workerId, workerConfig, globalWorkers, (ws) => { globalWorkers = ws }, verboseFlag)

      try {
        const result = await runInstance(worker, filtered[idx], idx, filtered.length)
        results[idx] = result
        savePartial()
      } catch (err: any) {
        console.error(`[${idx + 1}/${filtered.length}] CRASH ${filtered[idx].task_id}: ${err.message}`)
        results[idx] = {
          task_id: filtered[idx].task_id, level: filtered[idx].Level,
          predicted_answer: '', gold_answer: filtered[idx]['Final answer'],
          correct: false, durationS: 0,
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
  const correct = finalResults.filter(r => r.correct).length
  const withError = finalResults.filter(r => r.error).length

  const cost = computeCost(finalResults, modelArg)

  console.log('')
  console.log('='.repeat(60))
  console.log('GAIA RESULTS')
  console.log('='.repeat(60))
  console.log(`  Model:        ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Split:        ${splitArg}`)
  console.log(`  Total:        ${finalResults.length}`)
  console.log(`  Correct:      ${correct} (${(correct / finalResults.length * 100).toFixed(1)}%)`)
  console.log(`  Incorrect:    ${finalResults.length - correct - withError}`)
  console.log(`  Errors:       ${withError}`)
  console.log('')

  for (const level of [1, 2, 3]) {
    const levelResults = finalResults.filter(r => r.level === level)
    if (levelResults.length === 0) continue
    const levelCorrect = levelResults.filter(r => r.correct).length
    console.log(`  Level ${level}:  ${levelCorrect}/${levelResults.length} (${(levelCorrect / levelResults.length * 100).toFixed(1)}%)`)
  }
  console.log('')

  printCostSummary(cost, totalTime)
  console.log('')

  // Write predictions JSONL
  const predictionsPath = resolve(dataDir, `predictions-${modelArg}-${splitArg}-${Date.now()}.jsonl`)
  const modelName = shogoModelName(modelArg)
  for (const r of finalResults) {
    const prediction = {
      task_id: r.task_id,
      model_name_or_path: modelName,
      model_answer: r.predicted_answer,
    }
    appendFileSync(predictionsPath, JSON.stringify(prediction) + '\n')
  }
  console.log(`Predictions saved to: ${predictionsPath}`)

  // Write detailed results
  const detailedPath = resolve(tmpdir(), `gaia-results-${modelArg}-${splitArg}-${Date.now()}.json`)
  writeFileSync(detailedPath, JSON.stringify({
    benchmark: 'gaia',
    model: MODEL_MAP[modelArg] || modelArg,
    split: splitArg,
    timestamp: new Date().toISOString(),
    results: finalResults,
    summary: {
      total: finalResults.length,
      correct, withError,
      accuracy: `${(correct / finalResults.length * 100).toFixed(1)}%`,
      totalCost: '$' + cost.totalCost.toFixed(2),
      totalDurationS: Math.round(totalTime),
    },
  }, null, 2))
  console.log(`Detailed results saved to: ${detailedPath}`)

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
