#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GAIA Self-Improving Agent Harness
 *
 * Runs GAIA validation tasks in iterative rounds. After each round the
 * agent reviews its mistakes and writes skill files to improve its
 * performance on the next round. Skills persist on the Docker worker's
 * filesystem and are automatically loaded into the system prompt by
 * the AgentGateway's skill-loading machinery.
 *
 * Usage:
 *   bun run src/evals/gaia-learn.ts --model haiku --iterations 5
 *   bun run src/evals/gaia-learn.ts --model haiku --iterations 10 --batch-size 20 --verbose
 *   bun run src/evals/gaia-learn.ts --model haiku --level 1 --iterations 3 --build
 *   bun run src/evals/gaia-learn.ts --model haiku --evolve           # auto-load latest checkpoint, save new one
 *   bun run src/evals/gaia-learn.ts --checkpoint .gaia/checkpoints/haiku-72pct-2026-03-30T01-27  # resume from checkpoint
 */

import {
  existsSync, writeFileSync, cpSync, readdirSync,
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
  isWorkerHealthy,
} from './docker-worker'

loadEnvFromDisk(REPO_ROOT)

import { loadJsonl, computeCost, printCostSummary, saveCheckpoint, loadCheckpoint, getLatestCheckpoint } from './bench-utils'
import { sendTurn, type EvalRunnerConfig, type ParsedAgentResponse } from './runner'
import { buildGAIAPrompt } from './gaia-prompt'
import {
  buildReflectionPrompt, computeIterationStats,
  type TaskOutcome,
} from './gaia-learn-prompt'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const modelArg = getArg(args, 'model', 'haiku')!
const splitArg = getArg(args, 'split', 'validation')!
const levelArg = getArg(args, 'level')
const maxIterations = parseInt(getArg(args, 'iterations', '5')!)
const batchSize = parseInt(getArg(args, 'batch-size', '0')!)
const filterArg = getArg(args, 'filter')
const startFrom = parseInt(getArg(args, 'start-from', '0')!)
const dataDir = getArg(args, 'data', resolve(REPO_ROOT, '.gaia/data'))!
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')
const evolveFlag = args.includes('--evolve')
const checkpointArg = getArg(args, 'checkpoint')
const plateauThreshold = parseInt(getArg(args, 'plateau', '2')!)

const levelOffset = levelArg ? parseInt(levelArg) - 1 : 0
const BASE_PORT = 7450 + levelOffset * 10

// ---------------------------------------------------------------------------
// GAIA instance type (same as gaia.ts)
// ---------------------------------------------------------------------------

interface GAIAInstance {
  task_id: string
  Question: string
  Level: number | string
  'Final answer': string
  file_name: string
  file_path: string
  'Annotator Metadata'?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Answer extraction and scoring (duplicated from gaia.ts for independence)
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
    // Normalize whitespace around delimiters (; , :)
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s*,\s*/g, ', ')
    .trim()
  const num = parseFloat(normalized)
  if (!isNaN(num) && normalized === String(num)) normalized = String(num)
  return normalized
}

function scoreAnswer(predicted: string, gold: string): boolean {
  const normPred = normalizeAnswer(predicted)
  const normGold = normalizeAnswer(gold)
  if (normPred === normGold) return true

  // List comparison (comma or semicolon separated)
  for (const sep of [',', ';']) {
    if (normGold.includes(sep)) {
      const goldItems = normGold.split(sep).map(s => s.trim()).sort()
      const predItems = normPred.split(sep).map(s => s.trim()).sort()
      if (goldItems.length === predItems.length && goldItems.every((g, i) => g === predItems[i])) return true
    }
  }

  // Numeric tolerance: exact match within 1% relative or 0.01 absolute
  const goldNum = parseFloat(normGold)
  const predNum = parseFloat(normPred)
  if (!isNaN(goldNum) && !isNaN(predNum)) {
    if (Math.abs(goldNum - predNum) < 0.01) return true
    if (goldNum !== 0 && Math.abs((goldNum - predNum) / goldNum) < 0.01) return true
  }

  // Containment: if gold is a sentence and predicted is the key phrase within it (or vice versa)
  if (normGold.length > 10 && normPred.length > 3 && normGold.includes(normPred)) return true
  if (normPred.length > 10 && normGold.length > 3 && normPred.includes(normGold)) return true

  return false
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
    `  3. Convert Parquet to JSONL\n` +
    `\nOr place a JSONL file at: ${jsonlPath}`,
  )
}

// ---------------------------------------------------------------------------
// Run a single GAIA task (returns outcome for reflection)
// ---------------------------------------------------------------------------

async function runTask(
  worker: DockerWorker,
  instance: GAIAInstance,
  index: number,
  total: number,
): Promise<TaskOutcome & { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> {
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

  const level = Number(instance.Level)
  const prompt = buildGAIAPrompt({
    taskId: instance.task_id,
    question: instance.Question,
    level,
    hasAttachment,
    attachmentPath,
  })

  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: 600_000,
    verbose: verboseFlag,
    workspaceDir: worker.dir,
  }

  const messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }> = [
    { role: 'user', parts: [{ type: 'text', text: prompt }] },
  ]

  console.log(`  [${index + 1}/${total}] L${instance.Level} ${instance.task_id} ...`)

  let resp: ParsedAgentResponse
  try {
    resp = await sendTurn(messages, config)
  } catch (err: any) {
    console.log(`  [${index + 1}/${total}] ERROR ${instance.task_id}: ${err.message}`)
    return {
      task_id: instance.task_id, level,
      question: instance.Question,
      predicted_answer: '', gold_answer: instance['Final answer'],
      correct: false, toolCalls: 0, error: err.message,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
  }

  const predictedAnswer = extractFinalAnswer(resp.text)
  const goldAnswer = instance['Final answer']
  const correct = scoreAnswer(predictedAnswer, goldAnswer)

  const status = correct ? 'CORRECT' : 'WRONG'
  console.log(`  [${index + 1}/${total}] ${status} L${level} ${instance.task_id} predicted="${predictedAnswer}" gold="${goldAnswer}"`)

  const toolTrace = resp.toolCalls.map(tc => ({
    tool: tc.name,
    input: JSON.stringify(tc.input).slice(0, 200),
    durationMs: tc.durationMs,
    error: tc.error,
  }))

  return {
    task_id: instance.task_id, level,
    question: instance.Question,
    predicted_answer: predictedAnswer, gold_answer: goldAnswer,
    correct, toolCalls: resp.toolCalls.length, toolTrace,
    inputTokens: resp.inputTokens, outputTokens: resp.outputTokens,
    cacheReadTokens: resp.cacheReadTokens, cacheWriteTokens: resp.cacheWriteTokens,
  }
}

// ---------------------------------------------------------------------------
// Run a batch of tasks
// ---------------------------------------------------------------------------

async function runBatch(
  worker: DockerWorker,
  tasks: GAIAInstance[],
  iteration: number,
): Promise<TaskOutcome[]> {
  console.log(`\n--- Iteration ${iteration + 1}: Running ${tasks.length} tasks ---`)

  await configureWorkerForTask(worker, {
    model: modelArg,
    mode: 'none',
    promptProfile: 'full',
    evalLabel: undefined,
    verbose: verboseFlag,
  })

  const outcomes: TaskOutcome[] = []

  for (let i = 0; i < tasks.length; i++) {
    try { Bun.gc(true) } catch {}

    if (!(await isWorkerHealthy(worker))) {
      console.log('  [lifecycle] Worker unhealthy, restarting...')
      stopDockerWorker(worker)
      await Bun.sleep(3000)
      const fresh = await startDockerWorker(worker.id, workerConfig)
      Object.assign(worker, fresh)
      globalWorkers = [worker]

      await configureWorkerForTask(worker, {
        model: modelArg,
        mode: 'none',
        promptProfile: 'full',
        evalLabel: undefined,
        verbose: verboseFlag,
      })
    }

    const outcome = await runTask(worker, tasks[i], i, tasks.length)
    outcomes.push(outcome)
  }

  return outcomes
}

// ---------------------------------------------------------------------------
// Reflect — send mistake analysis, let agent write skills
// ---------------------------------------------------------------------------

async function reflectAndLearn(
  worker: DockerWorker,
  outcomes: TaskOutcome[],
  iteration: number,
  previousAccuracy?: number,
): Promise<void> {
  const stats = computeIterationStats(outcomes, iteration)
  const currentSkills = listSkillFiles(worker.dir)

  const reflectionPrompt = buildReflectionPrompt({
    iteration,
    outcomes,
    stats,
    currentSkills,
    previousAccuracy,
  })

  console.log(`\n--- Iteration ${iteration + 1}: Reflection phase ---`)
  console.log(`  Sending reflection to agent (${outcomes.filter(o => o.correct).length} correct, ${outcomes.filter(o => !o.correct).length} wrong)...`)

  try {
    await fetch(`http://localhost:${worker.port}/agent/session/reset`, { method: 'POST' })
  } catch {}

  const messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }> = [
    { role: 'user', parts: [{ type: 'text', text: reflectionPrompt }] },
  ]

  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: 600_000,
    verbose: verboseFlag,
    workspaceDir: worker.dir,
  }

  try {
    const resp = await sendTurn(messages, config)
    console.log(`  Reflection complete: ${resp.toolCalls.length} tool calls`)
    if (verboseFlag) {
      const writeOps = resp.toolCalls.filter(tc => tc.name === 'write_file' || tc.name === 'edit_file')
      for (const op of writeOps) {
        console.log(`    ${op.name}: ${JSON.stringify(op.input).slice(0, 100)}`)
      }
    }
  } catch (err: any) {
    console.error(`  Reflection failed: ${err.message}`)
  }

  const skillsAfter = listSkillFiles(worker.dir)
  console.log(`  Skills after reflection: ${skillsAfter.length > 0 ? skillsAfter.join(', ') : '(none)'}`)
}

// ---------------------------------------------------------------------------
// Skill file listing
// ---------------------------------------------------------------------------

function listSkillFiles(workspaceDir: string): string[] {
  const files: string[] = []

  // Flat legacy: skills/*.md
  const flatDir = join(workspaceDir, 'skills')
  if (existsSync(flatDir)) {
    files.push(...readdirSync(flatDir).filter(f => f.endsWith('.md')))
  }

  // Native Shogo: .shogo/skills/<name>/SKILL.md
  const shogoDir = join(workspaceDir, '.shogo', 'skills')
  if (existsSync(shogoDir)) {
    for (const entry of readdirSync(shogoDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(shogoDir, entry.name, 'SKILL.md'))) {
        files.push(`${entry.name}/SKILL.md`)
      }
    }
  }

  return [...new Set(files)].sort()
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let globalWorkers: DockerWorker[] = []

registerCleanupHandlers(() => globalWorkers, 'gaia-learn-crash.log')

// Worker config (module-level so runBatch can access it for restarts)
let workerConfig: DockerWorkerConfig

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('GAIA SELF-IMPROVING AGENT')
  console.log('='.repeat(60))
  console.log(`  Model:       ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Split:       ${splitArg}`)
  console.log(`  Iterations:  ${maxIterations}`)
  console.log(`  Batch size:  ${batchSize || 'all'}`)
  console.log(`  Plateau:     ${plateauThreshold} iterations`)
  console.log(`  Data:        ${dataDir}`)
  if (levelArg) console.log(`  Level:       ${levelArg}`)
  if (evolveFlag) console.log(`  Evolve:      on (checkpoint save/load)`)
  if (checkpointArg) console.log(`  Checkpoint:  ${checkpointArg}`)
  console.log('')

  // Load and filter tasks
  const instances = loadInstances()
  let tasks = instances

  if (levelArg) {
    const level = parseInt(levelArg)
    tasks = tasks.filter(i => Number(i.Level) === level)
  }
  if (filterArg) {
    const patterns = filterArg.toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    tasks = tasks.filter(i => patterns.some(p => i.task_id.toLowerCase().includes(p)))
  }
  if (startFrom > 0) {
    console.log(`  Skipping first ${startFrom} tasks (--start-from)`)
    tasks = tasks.slice(startFrom)
  }
  if (batchSize > 0 && batchSize < tasks.length) {
    tasks = tasks.slice(0, batchSize)
  }

  const levelCounts = [1, 2, 3].map(l => `L${l}:${tasks.filter(i => i.Level === l).length}`)
  console.log(`  Tasks: ${tasks.length} (${levelCounts.join(' ')})`)
  console.log('')

  if (tasks.length === 0) {
    console.log('No tasks found')
    process.exit(1)
  }

  // Docker setup
  const image = DEFAULT_RUNTIME_IMAGE
  await ensureDockerImage(image, { build: buildFlag })
  writeDockerEnvFile()

  workerConfig = evalWorkerConfig({
    image,
    containerPrefix: `gaia-learn-L${levelArg || 'all'}`,
    baseHostPort: BASE_PORT,
    model: modelArg,
    verbose: verboseFlag,
  })

  const worker = await startDockerWorker(0, workerConfig)
  globalWorkers = [worker]

  // Load checkpoint if specified (or auto-detect latest for this model with --evolve)
  if (checkpointArg) {
    const cpPath = resolve(checkpointArg)
    if (existsSync(cpPath)) {
      loadCheckpoint(cpPath, worker.dir)
    } else {
      console.log(`  Warning: checkpoint not found: ${cpPath}`)
    }
  } else if (evolveFlag) {
    const latest = getLatestCheckpoint('gaia', modelArg)
    if (latest) {
      console.log(`  Auto-loading latest checkpoint for ${modelArg}...`)
      loadCheckpoint(latest, worker.dir)
    }
  }

  const overallStart = Date.now()
  const history: Array<{
    iteration: number
    accuracy: number
    correct: number
    total: number
    skills: string[]
    outcomes: TaskOutcome[]
  }> = []

  let plateauCount = 0

  // ---------------------------------------------------------------------------
  // Iteration loop
  // ---------------------------------------------------------------------------

  for (let iter = 0; iter < maxIterations; iter++) {
    const outcomes = await runBatch(worker, tasks, iter)
    const stats = computeIterationStats(outcomes, iter)
    const accuracy = stats.total > 0 ? (stats.correct / stats.total * 100) : 0

    const skills = listSkillFiles(worker.dir)
    history.push({ iteration: iter, accuracy, correct: stats.correct, total: stats.total, skills: [...skills], outcomes })

    console.log('')
    console.log(`=== Iteration ${iter + 1} Results ===`)
    console.log(`  Accuracy: ${stats.correct}/${stats.total} (${accuracy.toFixed(1)}%)`)
    for (const { level, total, correct } of stats.byLevel) {
      if (total === 0) continue
      console.log(`  Level ${level}: ${correct}/${total} (${(correct / total * 100).toFixed(1)}%)`)
    }
    console.log(`  Skills: ${skills.length > 0 ? skills.join(', ') : '(none)'}`)

    // Save checkpoint after every iteration so progress survives crashes
    if (evolveFlag) {
      const cpDir = saveCheckpoint('gaia', worker.dir, {
        model: MODEL_MAP[modelArg] || modelArg,
        accuracy,
        iterations: iter + 1,
        skills: [...skills],
      })
      console.log(`  Checkpoint saved: ${cpDir}`)
    }

    // Check plateau
    const previousAccuracy = iter > 0 ? history[iter - 1].accuracy : undefined
    if (previousAccuracy !== undefined && accuracy <= previousAccuracy) {
      plateauCount++
      console.log(`  Plateau count: ${plateauCount}/${plateauThreshold}`)
    } else {
      plateauCount = 0
    }

    if (plateauCount >= plateauThreshold) {
      console.log(`\n  Stopping: accuracy plateaued for ${plateauThreshold} iterations`)
      break
    }

    if (iter === maxIterations - 1) {
      console.log(`\n  Reached max iterations (${maxIterations})`)
      break
    }

    // Reflect and learn
    await reflectAndLearn(worker, outcomes, iter, previousAccuracy)
  }

  // ---------------------------------------------------------------------------
  // Final summary
  // ---------------------------------------------------------------------------

  const totalTime = (Date.now() - overallStart) / 1000

  // Collect cost across all iterations
  const allOutcomes = history.flatMap(h => h.outcomes)
  const cost = computeCost(
    allOutcomes.map(o => ({
      inputTokens: (o as any).inputTokens || 0,
      outputTokens: (o as any).outputTokens || 0,
      cacheReadTokens: (o as any).cacheReadTokens || 0,
      cacheWriteTokens: (o as any).cacheWriteTokens || 0,
    })),
    modelArg,
  )

  stopDockerWorker(worker)
  globalWorkers = []
  cleanupDockerEnvFile()

  console.log('')
  console.log('='.repeat(60))
  console.log('GAIA SELF-IMPROVING RESULTS')
  console.log('='.repeat(60))
  console.log('')
  console.log('Iteration History:')
  for (const h of history) {
    console.log(`  ${(h.iteration + 1).toString().padStart(2)}. ${h.accuracy.toFixed(1)}% (${h.correct}/${h.total}) — skills: ${h.skills.length}`)
  }

  if (history.length >= 2) {
    const first = history[0].accuracy
    const last = history[history.length - 1].accuracy
    const delta = last - first
    console.log('')
    console.log(`  Improvement: ${first.toFixed(1)}% -> ${last.toFixed(1)}% (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp over ${history.length} iterations)`)
  }

  console.log('')
  printCostSummary(cost, totalTime)

  // Export final skills
  const finalSkills = history[history.length - 1]?.skills || []
  if (finalSkills.length > 0) {
    console.log('')
    console.log('Learned skills:')
    for (const skill of finalSkills) {
      console.log(`  skills/${skill}`)
    }
    console.log('')
    console.log(`These skills are in the worker workspace. Copy them to any Shogo agent's skills/ directory to reuse.`)
  }

  // Write detailed results
  const resultsPath = resolve(tmpdir(), `gaia-learn-results-${modelArg}-${Date.now()}.json`)
  writeFileSync(resultsPath, JSON.stringify({
    benchmark: 'gaia-learn',
    model: MODEL_MAP[modelArg] || modelArg,
    split: splitArg,
    maxIterations,
    timestamp: new Date().toISOString(),
    history: history.map(h => ({
      iteration: h.iteration,
      accuracy: h.accuracy,
      correct: h.correct,
      total: h.total,
      skills: h.skills,
    })),
    totalCost: cost.totalCost,
    totalDurationS: Math.round(totalTime),
  }, null, 2))
  console.log(`\nResults saved: ${resultsPath}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()
  process.exit(1)
})
