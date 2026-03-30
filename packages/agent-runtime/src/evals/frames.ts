#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FRAMES Benchmark Runner
 *
 * Loads the FRAMES dataset (824 multi-hop questions), sends each to the Shogo
 * agent, extracts the final answer, and scores with exact-match against gold.
 *
 * Dataset: HuggingFace `google/frames-benchmark` (CSV)
 * Download with: huggingface-cli download google/frames-benchmark --repo-type dataset
 *
 * Usage:
 *   bun run src/evals/frames.ts --model haiku
 *   bun run src/evals/frames.ts --model sonnet --workers 2
 *   bun run src/evals/frames.ts --model haiku --reasoning-type numerical --verbose
 *   bun run src/evals/frames.ts --model haiku --filter "some keyword" --build
 */

import {
  writeFileSync, appendFileSync,
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

import { loadCsv, computeCost, printCostSummary, savePartialResults, cleanupPartialFile, printErrorSummary, ensureWorkerHealthy, shogoModelName } from './bench-utils'
import { sendTurn, type EvalRunnerConfig, type ParsedAgentResponse } from './runner'
import { buildFRAMESPrompt } from './frames-prompt'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const modelArg = getArg(args, 'model', 'haiku')!
const workersArg = parseInt(getArg(args, 'workers', '1')!)
const filterArg = getArg(args, 'filter')
const reasoningTypeArg = getArg(args, 'reasoning-type')
const maxHopsArg = getArg(args, 'max-hops')
const promptProfileArg = getArg(args, 'prompt-profile') as 'full' | 'swe' | 'general' | undefined
const dataDir = getArg(args, 'data', resolve(REPO_ROOT, '.frames/data'))!
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')

const BASE_PORT = 7600

// ---------------------------------------------------------------------------
// FRAMES instance type
// ---------------------------------------------------------------------------

interface FRAMESInstance {
  Prompt: string
  Answer: string
  reasoning_types: string
  wiki_links: string
  wikipedia_link_1: string
  wikipedia_link_2: string
  wikipedia_link_3: string
  wikipedia_link_4: string
  wikipedia_link_5: string
}

function countHops(instance: FRAMESInstance): number {
  let count = 0
  for (let i = 1; i <= 5; i++) {
    if ((instance as any)[`wikipedia_link_${i}`]) count++
  }
  if ((instance as any)['wikipedia_link_6']) count++
  if ((instance as any)['wikipedia_link_7']) count++
  if ((instance as any)['wikipedia_link_8']) count++
  if ((instance as any)['wikipedia_link_9']) count++
  if ((instance as any)['wikipedia_link_10']) count++
  if ((instance as any)['wikipedia_link_11+']) count++
  return count
}

// ---------------------------------------------------------------------------
// Dataset loader
// ---------------------------------------------------------------------------

function loadInstances(): FRAMESInstance[] {
  const csvPath = resolve(dataDir, 'frames.csv')
  return loadCsv<FRAMESInstance>(csvPath,
    `\nTo prepare the dataset:\n` +
    `  1. pip install huggingface_hub datasets\n` +
    `  2. huggingface-cli download google/frames-benchmark --repo-type dataset --local-dir ${dataDir}\n` +
    `\nOr manually download from https://huggingface.co/datasets/google/frames-benchmark\n` +
    `and place the CSV file at: ${csvPath}`,
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
    .toLowerCase()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/\.$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // Strip leading articles unless they appear to be part of a proper noun
  normalized = normalized.replace(/^(the|a|an) /i, '')

  // Strip ordinal suffixes: "37th" → "37", "1st" → "1"
  normalized = normalized.replace(/^(\d+)(st|nd|rd|th)$/i, '$1')

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

  // Containment: gold is a sentence that contains the predicted answer as core content
  // e.g. gold="Mendelevium is named after Dmitri Mendeleev." pred="Dmitri Mendeleev"
  if (normPred.length >= 3 && normGold.includes(normPred)) return true
  if (normGold.length >= 3 && normPred.includes(normGold)) return true

  // List comparison (order-independent)
  if (normGold.includes(',')) {
    const goldItems = normGold.split(',').map(s => normalizeAnswer(s)).sort()
    const predItems = normPred.split(',').map(s => normalizeAnswer(s)).sort()
    if (goldItems.length === predItems.length && goldItems.every((g, i) => g === predItems[i])) {
      return true
    }
  }

  // Numeric comparison with tolerance
  const goldNum = parseFloat(normGold)
  const predNum = parseFloat(normPred)
  if (!isNaN(goldNum) && !isNaN(predNum)) {
    if (Math.abs(goldNum - predNum) < 1e-6) return true
    if (goldNum !== 0 && Math.abs((goldNum - predNum) / goldNum) < 0.01) return true
  }

  // "Christmas Day" vs "Christmas" — check word overlap for short answers
  const goldWords = normGold.split(' ')
  const predWords = normPred.split(' ')
  if (goldWords.length <= 3 && predWords.length <= 3) {
    const goldSet = new Set(goldWords)
    const predSet = new Set(predWords)
    const intersection = [...goldSet].filter(w => predSet.has(w))
    if (intersection.length > 0 && intersection.length >= Math.min(goldSet.size, predSet.size)) {
      return true
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// Instance result
// ---------------------------------------------------------------------------

interface InstanceResult {
  index: number
  question: string
  reasoning_types: string
  num_hops: number
  predicted_answer: string
  gold_answer: string
  correct: boolean
  durationS: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCalls: number
  toolNames: string[]
  error?: string
}

/** Compact tool name counts for per-instance log lines. */
function summarizeTools(names: string[]): string {
  const counts: Record<string, number> = {}
  for (const n of names) counts[n] = (counts[n] || 0) + 1
  return Object.entries(counts).map(([n, c]) => c > 1 ? `${n}:${c}` : n).join(',')
}

// ---------------------------------------------------------------------------
// Run a single instance
// ---------------------------------------------------------------------------

async function runInstance(
  worker: DockerWorker,
  instance: FRAMESInstance,
  index: number,
  total: number,
): Promise<InstanceResult> {
  const startTime = Date.now()
  const numHops = countHops(instance)

  try { Bun.gc(true) } catch {}

  await configureWorkerForTask(worker, {
    model: modelArg,
    mode: 'none',
    promptProfile: promptProfileArg || 'general',
    evalLabel: undefined,
    verbose: verboseFlag,
  })

  try {
    await fetch(`http://localhost:${worker.port}/agent/session/reset`, { method: 'POST' })
  } catch {}

  const prompt = buildFRAMESPrompt({
    question: instance.Prompt,
    index,
    reasoningTypes: instance.reasoning_types,
    numHops,
  })

  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: 600_000,
    verbose: verboseFlag,
    workspaceDir: worker.dir,
  }

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0
  let totalToolCalls = 0
  const allToolNames: string[] = []

  const shortQ = instance.Prompt.slice(0, 60).replace(/\n/g, ' ')
  console.log(`[${index + 1}/${total}] hops=${numHops} ${shortQ}...`)

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
    for (const tc of resp.toolCalls) allToolNames.push(tc.name)
  } catch (err: any) {
    const duration = (Date.now() - startTime) / 1000
    console.log(`[${index + 1}/${total}] ERROR: ${err.message}`)
    return {
      index, question: instance.Prompt,
      reasoning_types: instance.reasoning_types, num_hops: numHops,
      predicted_answer: '', gold_answer: instance.Answer,
      correct: false, durationS: duration,
      inputTokens: totalInput, outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
      toolCalls: totalToolCalls, toolNames: allToolNames, error: err.message,
    }
  }

  const predictedAnswer = extractFinalAnswer(resp.text)
  const goldAnswer = instance.Answer
  const correct = scoreAnswer(predictedAnswer, goldAnswer)

  const duration = (Date.now() - startTime) / 1000
  const status = correct ? 'CORRECT' : 'WRONG'
  const toolSummary = summarizeTools(allToolNames)
  console.log(`[${index + 1}/${total}] ${status} hops=${numHops} (${duration.toFixed(1)}s) tools=[${toolSummary}] predicted="${predictedAnswer}" gold="${goldAnswer}"`)

  return {
    index, question: instance.Prompt,
    reasoning_types: instance.reasoning_types, num_hops: numHops,
    predicted_answer: predictedAnswer, gold_answer: goldAnswer,
    correct, durationS: duration,
    inputTokens: totalInput, outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
    toolCalls: totalToolCalls, toolNames: allToolNames,
  }
}

// ---------------------------------------------------------------------------
// Cleanup & signal handling
// ---------------------------------------------------------------------------

let globalWorkers: DockerWorker[] = []

registerCleanupHandlers(() => globalWorkers, 'frames-crash.log')

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('FRAMES BENCHMARK')
  console.log('='.repeat(60))
  console.log(`  Model:     ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Profile:   ${promptProfileArg || 'general'}`)
  console.log(`  Workers:   ${workersArg}`)
  console.log(`  Data:      ${dataDir}`)
  if (reasoningTypeArg) console.log(`  Reasoning: ${reasoningTypeArg}`)
  if (maxHopsArg) console.log(`  Max hops:  ${maxHopsArg}`)
  console.log('')

  const instances = loadInstances()
  let filtered = instances

  if (reasoningTypeArg) {
    const rt = reasoningTypeArg.toLowerCase()
    filtered = filtered.filter(i =>
      i.reasoning_types.toLowerCase().includes(rt),
    )
  }
  if (maxHopsArg) {
    const max = parseInt(maxHopsArg)
    filtered = filtered.filter(i => countHops(i) <= max)
  }
  if (filterArg) {
    const f = filterArg.toLowerCase()
    filtered = filtered.filter(i =>
      i.Prompt.toLowerCase().includes(f) || i.Answer.toLowerCase().includes(f),
    )
  }

  // Collect reasoning type breakdown
  const typeCounts: Record<string, number> = {}
  for (const inst of filtered) {
    const types = inst.reasoning_types || 'unknown'
    typeCounts[types] = (typeCounts[types] || 0) + 1
  }

  // Collect hop count breakdown
  const hopCounts: Record<number, number> = {}
  for (const inst of filtered) {
    const h = countHops(inst)
    hopCounts[h] = (hopCounts[h] || 0) + 1
  }

  console.log(`  Instances: ${filtered.length}`)
  console.log(`  Hops:      ${Object.entries(hopCounts).sort(([a], [b]) => +a - +b).map(([h, n]) => `${h}:${n}`).join(' ')}`)
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
  const partialPath = resolve(tmpdir(), `frames-partial-${modelArg}-${Date.now()}.json`)

  let nextIndex = 0

  function savePartial() {
    savePartialResults(partialPath, results)
  }

  const workerConfig = evalWorkerConfig({
    image,
    containerPrefix: 'frames-worker',
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
        console.error(`[${idx + 1}/${filtered.length}] CRASH #${idx}: ${err.message}`)
        results[idx] = {
          index: idx, question: filtered[idx].Prompt,
          reasoning_types: filtered[idx].reasoning_types,
          num_hops: countHops(filtered[idx]),
          predicted_answer: '', gold_answer: filtered[idx].Answer,
          correct: false, durationS: 0,
          inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          toolCalls: 0, toolNames: [], error: err.message,
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
  console.log('FRAMES RESULTS')
  console.log('='.repeat(60))
  console.log(`  Model:        ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Total:        ${finalResults.length}`)
  console.log(`  Correct:      ${correct} (${(correct / finalResults.length * 100).toFixed(1)}%)`)
  console.log(`  Incorrect:    ${finalResults.length - correct - withError}`)
  console.log(`  Errors:       ${withError}`)
  console.log('')

  // Breakdown by reasoning type
  const reasoningGroups: Record<string, InstanceResult[]> = {}
  for (const r of finalResults) {
    const key = r.reasoning_types || 'unknown'
    ;(reasoningGroups[key] ??= []).push(r)
  }
  console.log('BY REASONING TYPE')
  console.log('-'.repeat(50))
  for (const [type, group] of Object.entries(reasoningGroups).sort(([a], [b]) => a.localeCompare(b))) {
    const c = group.filter(r => r.correct).length
    console.log(`  ${type.padEnd(30)} ${c}/${group.length} (${(c / group.length * 100).toFixed(1)}%)`)
  }
  console.log('')

  // Breakdown by hop count
  const hopGroups: Record<number, InstanceResult[]> = {}
  for (const r of finalResults) {
    ;(hopGroups[r.num_hops] ??= []).push(r)
  }
  console.log('BY HOP COUNT')
  console.log('-'.repeat(50))
  for (const [hops, group] of Object.entries(hopGroups).sort(([a], [b]) => +a - +b)) {
    const c = group.filter(r => r.correct).length
    console.log(`  ${String(hops).padEnd(5)} hops:  ${c}/${group.length} (${(c / group.length * 100).toFixed(1)}%)`)
  }
  console.log('')

  // Tool usage summary
  const globalToolCounts: Record<string, number> = {}
  let instancesUsingSearch = 0
  let instancesUsingFetch = 0
  let instancesUsingExec = 0
  let instancesUsingFileTools = 0
  for (const r of finalResults) {
    const nameSet = new Set(r.toolNames)
    if (nameSet.has('web_search') || nameSet.has('web')) instancesUsingSearch++
    if (nameSet.has('web_fetch') || nameSet.has('browser')) instancesUsingFetch++
    if (nameSet.has('exec')) instancesUsingExec++
    if (nameSet.has('read_file') || nameSet.has('glob') || nameSet.has('grep')) instancesUsingFileTools++
    for (const n of r.toolNames) globalToolCounts[n] = (globalToolCounts[n] || 0) + 1
  }
  const totalToolCallCount = finalResults.reduce((s, r) => s + r.toolCalls, 0)

  console.log('TOOL USAGE')
  console.log('-'.repeat(50))
  console.log(`  Total tool calls:        ${totalToolCallCount}`)
  console.log(`  Avg tools/instance:      ${(totalToolCallCount / finalResults.length).toFixed(1)}`)
  console.log(`  Instances using search:  ${instancesUsingSearch}/${finalResults.length} (${(instancesUsingSearch / finalResults.length * 100).toFixed(0)}%)`)
  console.log(`  Instances using fetch:   ${instancesUsingFetch}/${finalResults.length} (${(instancesUsingFetch / finalResults.length * 100).toFixed(0)}%)`)
  console.log(`  Instances using exec:    ${instancesUsingExec}/${finalResults.length} (${(instancesUsingExec / finalResults.length * 100).toFixed(0)}%)`)
  console.log(`  Instances using files:   ${instancesUsingFileTools}/${finalResults.length} (${(instancesUsingFileTools / finalResults.length * 100).toFixed(0)}%)`)
  console.log('')
  console.log('  By tool name:')
  for (const [name, count] of Object.entries(globalToolCounts).sort(([, a], [, b]) => b - a)) {
    console.log(`    ${name.padEnd(20)} ${count}`)
  }
  console.log('')

  printCostSummary(cost, totalTime)
  console.log('')

  // Write predictions JSONL
  const predictionsPath = resolve(dataDir, `predictions-${modelArg}-${Date.now()}.jsonl`)
  const modelName = shogoModelName(modelArg)
  for (const r of finalResults) {
    const prediction = {
      index: r.index,
      model_name_or_path: modelName,
      model_answer: r.predicted_answer,
    }
    appendFileSync(predictionsPath, JSON.stringify(prediction) + '\n')
  }
  console.log(`Predictions saved to: ${predictionsPath}`)

  // Write detailed results
  const detailedPath = resolve(tmpdir(), `frames-results-${modelArg}-${Date.now()}.json`)
  writeFileSync(detailedPath, JSON.stringify({
    benchmark: 'frames',
    model: MODEL_MAP[modelArg] || modelArg,
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

  printErrorSummary(finalResults.filter(r => r.error).map(r => ({ id: `#${r.index}`, error: r.error! })))

  cleanupPartialFile(partialPath)
}

main().catch(err => {
  console.error('Fatal:', err)
  globalWorkers.forEach(stopDockerWorker)
  globalWorkers = []
  cleanupDockerEnvFile()
  process.exit(1)
})
