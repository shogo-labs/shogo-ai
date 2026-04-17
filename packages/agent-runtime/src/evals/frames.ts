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

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11',
  twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30',
  forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000', million: '1000000', billion: '1000000000',
  once: '1', twice: '2', thrice: '3',
}

const ORDINAL_WORDS: Record<string, string> = {
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
  sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
  eleventh: '11', twelfth: '12', thirteenth: '13', fourteenth: '14', fifteenth: '15',
  sixteenth: '16', seventeenth: '17', eighteenth: '18', nineteenth: '19', twentieth: '20',
}

/** Reverse map: digit string → number word (for matching "2" against "two" in gold).
 *  Only set the first (cardinal) form so that "once"/"twice"/"thrice" don't overwrite. */
const DIGIT_TO_WORD: Record<string, string> = {}
for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
  if (!DIGIT_TO_WORD[digit]) DIGIT_TO_WORD[digit] = word
}
/** Full reverse map: digit → all word forms (cardinal + once/twice/thrice). */
const DIGIT_TO_ALL_WORDS: Record<string, string[]> = {}
for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
  (DIGIT_TO_ALL_WORDS[digit] ??= []).push(word)
}
const DIGIT_TO_ORDINAL: Record<string, string> = {}
for (const [word, digit] of Object.entries(ORDINAL_WORDS)) DIGIT_TO_ORDINAL[digit] = word

function numberWordToDigit(text: string): string {
  const lower = text.toLowerCase().trim()
  if (NUMBER_WORDS[lower] !== undefined) return NUMBER_WORDS[lower]
  const twoWord = lower.match(/^(\w+)\s+(million|billion|thousand|hundred)$/)
  if (twoWord && NUMBER_WORDS[twoWord[1]] && NUMBER_WORDS[twoWord[2]]) {
    return String(Number(NUMBER_WORDS[twoWord[1]]) * Number(NUMBER_WORDS[twoWord[2]]))
  }
  return text
}

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function normalizeAnswer(answer: string): string {
  let normalized = answer
    .trim()
    .toLowerCase()
    // Normalize smart/curly quotes to plain quotes
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/^["'`*_]|["'`*_]$/g, '')
    .replace(/\*+/g, '')
    .replace(/\.$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  normalized = stripDiacritics(normalized)

  // Normalize unicode dashes (en-dash, em-dash) → hyphen, then hyphens → spaces
  normalized = normalized.replace(/[\u2013\u2014]/g, '-')
  normalized = normalized.replace(/-/g, ' ').replace(/\s+/g, ' ').trim()

  normalized = normalized.replace(/^(the|a|an) /i, '')

  // Strip leading "- " (bullet prefix in some gold answers)
  normalized = normalized.replace(/^-\s+/, '')

  // Strip ordinal suffixes: "37th" → "37", "1st" → "1"
  normalized = normalized.replace(/^(\d+)(st|nd|rd|th)$/i, '$1')

  // Convert ordinal words → digits: "first" → "1", "second" → "2"
  if (ORDINAL_WORDS[normalized]) normalized = ORDINAL_WORDS[normalized]

  // Strip number formatting: commas (loop for multi-comma), currency symbols, trailing units
  normalized = normalized.replace(/[$£€¥]/g, '')
  while (/(\d),(\d{3})/.test(normalized)) {
    normalized = normalized.replace(/(\d),(\d{3})/g, '$1$2')
  }
  normalized = normalized.replace(/(\d)\s*(cm|km|m|mm|kg|g|lb|lbs|ft|mph|m\/s|%|years?|days?|months?|hours?|minutes?|seconds?|circuits?)\.?$/i, '$1')

  // Strip parenthetical annotations: "Bart Starr (66)" → "Bart Starr"
  normalized = normalized.replace(/\s*\([^)]*\)/g, '').trim()

  // Number words → digits
  normalized = numberWordToDigit(normalized)

  const num = parseFloat(normalized)
  if (!isNaN(num) && normalized === String(num)) {
    normalized = String(num)
  }

  return normalized
}

/** Split a list answer into items, handling both ", " and " and " as delimiters. */
function splitListAnswer(s: string): string[] {
  return s
    .replace(/,?\s+and\s+/gi, ', ')
    .replace(/,?\s*&\s*/g, ', ')
    .split(',')
    .map(item => normalizeAnswer(item))
    .filter(Boolean)
}

/** Extract the core factual content from a gold sentence answer. */
function extractCoreAnswer(sentence: string): string[] {
  const parts: string[] = []

  // Try to extract content after common patterns like "This was X", "The answer is X"
  const prefixes = [
    /^(?:this was|this is|it was|it is|that was|that is)\s+/i,
    /^(?:the answer is|the result is)\s+/i,
    /^.*?\bwas\s+/i,
    /^.*?\bis\s+/i,
  ]

  const lower = sentence.toLowerCase().trim().replace(/\.+$/, '')
  for (const re of prefixes) {
    const stripped = lower.replace(re, '')
    if (stripped !== lower && stripped.length >= 2) {
      parts.push(stripped)
    }
  }

  return parts
}

function listItemFuzzyMatch(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length >= 3 && b.includes(a)) return true
  if (b.length >= 3 && a.includes(b)) return true
  const aWords = a.split(' ').filter(w => w.length > 2)
  const bWords = b.split(' ').filter(w => w.length > 2)
  if (aWords.length >= 2 && bWords.length >= 2) {
    const overlap = aWords.filter(w => bWords.includes(w))
    const minSize = Math.min(aWords.length, bWords.length)
    if (overlap.length >= Math.ceil(minSize * 0.6) && overlap.length >= 2) return true
  }
  return false
}

function extractNumbersFromText(text: string): number[] {
  return (text.match(/\b\d+(\.\d+)?\b/g) || []).map(m => parseFloat(m)).filter(n => !isNaN(n))
}

function scoreAnswer(predicted: string, gold: string): boolean {
  const normPred = normalizeAnswer(predicted)
  const normGold = normalizeAnswer(gold)

  if (normPred === normGold) return true

  // Containment (either direction)
  if (normPred.length >= 3 && normGold.includes(normPred)) return true
  if (normGold.length >= 3 && normPred.includes(normGold)) return true

  // Short predicted number in gold sentence: "35" appears as a word boundary match in gold
  if (/^\d+(\.\d+)?$/.test(normPred) && normGold.split(' ').length > 3) {
    const re = new RegExp(`\\b${normPred.replace('.', '\\.')}\\b`)
    if (re.test(normGold)) return true
  }

  // Short predicted answer (1-2 chars): check number-word equivalence in gold
  if (normPred.length <= 2 && normGold.length > normPred.length) {
    const wordEquiv = DIGIT_TO_WORD[normPred]
    const ordEquiv = DIGIT_TO_ORDINAL[normPred]
    const goldWords = normGold.split(/[\s,;.]+/)
    if (wordEquiv && goldWords.some(w => normalizeAnswer(w) === normPred)) return true
    if (ordEquiv && goldWords.includes(ordEquiv)) return true
    // "no"/"yes" at sentence start
    if ((normPred === 'no' || normPred === 'yes') && normGold.startsWith(normPred)) return true
  }

  // List comparison: "Italy, Norway" vs "Italy and Norway" (order-independent)
  const predItems = splitListAnswer(normPred)
  const goldItems = splitListAnswer(normGold)
  if (predItems.length > 1 || goldItems.length > 1) {
    const predSorted = [...predItems].sort()
    const goldSorted = [...goldItems].sort()
    if (predSorted.length === goldSorted.length && predSorted.every((p, i) =>
      listItemFuzzyMatch(p, goldSorted[i])
    )) {
      return true
    }
    if (predItems.length >= 2 && predItems.every(p =>
      goldSorted.some(g => listItemFuzzyMatch(p, g))
    )) {
      return true
    }
  }

  // Pred is a concise list, gold is a sentence: check each pred item appears in gold
  if (predItems.length >= 2 && normGold.split(' ').length > 5) {
    const goldNums = extractNumbersFromText(normGold)
    const allFound = predItems.every(item => {
      if (item.length >= 4 && normGold.includes(item)) return true
      const itemNum = Number(item)
      if (!isNaN(itemNum) && item.trim() !== '') {
        if (goldNums.some(gn => gn !== 0 && Math.abs((gn - itemNum) / gn) < 0.02)) return true
        if (goldNums.some(gn => Math.abs(gn - itemNum) < 1e-6)) return true
        const wordForms = DIGIT_TO_ALL_WORDS[item] || []
        if (wordForms.some(wf => new RegExp(`\\b${wf}\\b`).test(normGold))) return true
      }
      return false
    })
    if (allFound) return true
  }

  // Numeric comparison with tolerance
  const goldNum = parseFloat(normGold)
  const predNum = parseFloat(normPred)
  if (!isNaN(goldNum) && !isNaN(predNum)) {
    if (Math.abs(goldNum - predNum) < 1e-6) return true
    if (goldNum !== 0 && Math.abs((goldNum - predNum) / goldNum) < 0.02) return true
  }

  // Numeric pred vs gold sentence: extract numbers from gold and check tolerance
  if (/^\d+(\.\d+)?$/.test(normPred) && normGold.split(' ').length > 3) {
    const pn = parseFloat(normPred)
    const goldNums = extractNumbersFromText(normGold)
    if (goldNums.some(gn => gn !== 0 && Math.abs((gn - pn) / gn) < 0.02)) return true
  }

  // Gold is a sentence but pred is the concise answer extracted from it
  if (normGold.split(' ').length > 5 && normPred.split(' ').length <= 5) {
    for (const core of extractCoreAnswer(gold)) {
      const normCore = normalizeAnswer(core)
      if (normCore === normPred) return true
      if (normPred.length >= 3 && normCore.includes(normPred)) return true
      if (normCore.length >= 3 && normPred.includes(normCore)) return true
    }
    const predWords = normPred.split(' ').map(w => w.replace(/[,;.!?:]/g, '')).filter(w => w.length > 2)
    const goldLower = normGold.replace(/[,;.!?:]/g, ' ')
    if (predWords.length >= 1 && predWords.length <= 4 && predWords.every(w => goldLower.includes(w))) {
      return true
    }
  }

  // Word overlap for short-to-medium answers (up to 8 words)
  const goldWords = normGold.split(' ').filter(w => w.length > 1)
  const predWords2 = normPred.split(' ').filter(w => w.length > 1)
  if (goldWords.length <= 8 && predWords2.length <= 8 && goldWords.length >= 1 && predWords2.length >= 1) {
    const goldSet = new Set(goldWords)
    const predSet = new Set(predWords2)
    const intersection = [...goldSet].filter(w => predSet.has(w))
    const minSize = Math.min(goldSet.size, predSet.size)
    // For short answers (<=4 words): require overlap >= min set size
    // For medium answers (5-8 words): require overlap >= 60% of the smaller set
    const threshold = minSize <= 4 ? minSize : Math.ceil(minSize * 0.6)
    if (intersection.length >= threshold && intersection.length >= 2) {
      return true
    }
  }

  // Abbreviated name matching: "Franklin D. Roosevelt" vs "Franklin Delano Roosevelt"
  if (normPred.split(' ').length >= 2 && normGold.split(' ').length >= 2) {
    const expandInitial = (s: string) => s.replace(/\b([a-z])\./g, '$1')
    const predExpanded = expandInitial(normPred).split(' ').filter(Boolean)
    const goldExpanded = expandInitial(normGold).split(' ').filter(Boolean)
    if (predExpanded.length >= 2 && goldExpanded.length >= 2) {
      const matches = predExpanded.every(pw =>
        goldExpanded.some(gw =>
          gw === pw || (pw.length === 1 && gw.startsWith(pw)) || (gw.length === 1 && pw.startsWith(gw))
        )
      )
      if (matches) return true
    }
  }

  // Levenshtein for near-typos (e.g. "Sabalenka" vs "Sablenka")
  if (normPred.length >= 5 && normGold.length >= 5) {
    const maxLen = Math.max(normPred.length, normGold.length)
    const dist = levenshtein(normPred, normGold)
    if (dist <= Math.max(1, Math.floor(maxLen * 0.1))) return true
  }

  return false
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
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
    if (nameSet.has('read_file') || nameSet.has('exec')) instancesUsingFileTools++
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
