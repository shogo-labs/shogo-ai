// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared utilities for external benchmark runners.
 *
 * Provides common patterns used across SWE-bench, GAIA, WebArena,
 * Terminal-Bench, FeatureBench, and Tau2 runners: JSONL loading,
 * cost calculation, result persistence, and cleanup handlers.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, cpSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'

import {
  type DockerWorker,
  MODEL_MAP,
  PRICING,
  stopDockerWorker,
  cleanupDockerEnvFile,
  isWorkerHealthy,
  startDockerWorker,
  type DockerWorkerConfig,
} from './docker-worker'

// ---------------------------------------------------------------------------
// JSONL dataset loading
// ---------------------------------------------------------------------------

/**
 * Load a JSONL file, stripping BOM and blank lines.
 * Exits the process with a helpful message if the file doesn't exist.
 */
export function loadJsonl<T>(jsonlPath: string, notFoundHelp?: string): T[] {
  if (!existsSync(jsonlPath)) {
    console.error(`Dataset not found: ${jsonlPath}`)
    if (notFoundHelp) console.error(notFoundHelp)
    process.exit(1)
  }

  let raw = readFileSync(jsonlPath, 'utf-8')
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  const lines = raw.split('\n').filter(l => l.trim())
  return lines.map(line => JSON.parse(line) as T)
}

// ---------------------------------------------------------------------------
// CSV dataset loading
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string with a header row into an array of objects.
 * Handles quoted fields (including embedded commas and newlines).
 */
export function loadCsv<T>(csvPath: string, notFoundHelp?: string): T[] {
  if (!existsSync(csvPath)) {
    console.error(`Dataset not found: ${csvPath}`)
    if (notFoundHelp) console.error(notFoundHelp)
    process.exit(1)
  }

  let raw = readFileSync(csvPath, 'utf-8')
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)

  const rows = parseCsvRows(raw)
  if (rows.length < 2) return []

  const headers = rows[0]
  return rows.slice(1).map(cols => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = cols[i] ?? ''
    }
    return obj as T
  })
}

/** RFC-4180-ish CSV row parser supporting quoted fields with embedded commas/newlines. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let i = 0
  const len = text.length

  while (i < len) {
    const { row, next } = parseCsvRow(text, i, len)
    rows.push(row)
    i = next
  }
  return rows
}

function parseCsvRow(text: string, start: number, len: number): { row: string[]; next: number } {
  const fields: string[] = []
  let i = start

  while (i < len) {
    if (text[i] === '"') {
      let value = ''
      i++ // skip opening quote
      while (i < len) {
        if (text[i] === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            value += '"'
            i += 2
          } else {
            i++ // skip closing quote
            break
          }
        } else {
          value += text[i++]
        }
      }
      fields.push(value)
      if (i < len && text[i] === ',') i++
      else if (i < len && (text[i] === '\n' || text[i] === '\r')) {
        if (text[i] === '\r' && i + 1 < len && text[i + 1] === '\n') i += 2
        else i++
        return { row: fields, next: i }
      }
    } else {
      let end = i
      while (end < len && text[end] !== ',' && text[end] !== '\n' && text[end] !== '\r') end++
      fields.push(text.slice(i, end))
      i = end
      if (i < len && text[i] === ',') i++
      else {
        if (text[i] === '\r' && i + 1 < len && text[i + 1] === '\n') i += 2
        else if (i < len) i++
        return { row: fields, next: i }
      }
    }
  }
  return { row: fields, next: i }
}

// ---------------------------------------------------------------------------
// Token / cost tracking
// ---------------------------------------------------------------------------

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface CostSummary extends TokenCounts {
  totalCost: number
  count: number
}

/** Sum token counts from an array of results that contain token fields. */
export function computeCost(results: TokenCounts[], modelArg: string): CostSummary {
  const totalInput = results.reduce((s, r) => s + r.inputTokens, 0)
  const totalOutput = results.reduce((s, r) => s + r.outputTokens, 0)
  const totalCacheRead = results.reduce((s, r) => s + r.cacheReadTokens, 0)
  const totalCacheWrite = results.reduce((s, r) => s + r.cacheWriteTokens, 0)
  const pricing = PRICING[modelArg] || PRICING.haiku
  const totalCost =
    totalInput * pricing.input +
    totalOutput * pricing.output +
    totalCacheRead * pricing.cacheRead +
    totalCacheWrite * pricing.cacheWrite

  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead,
    cacheWriteTokens: totalCacheWrite,
    totalCost,
    count: results.length,
  }
}

/** Print a standard cost summary block to the console. */
export function printCostSummary(cost: CostSummary, totalTimeS: number, perLabel = 'instance'): void {
  console.log('COST')
  console.log('-'.repeat(40))
  console.log(`  Input tokens:       ${cost.inputTokens.toLocaleString()}`)
  console.log(`  Output tokens:      ${cost.outputTokens.toLocaleString()}`)
  console.log(`  Cache read tokens:  ${cost.cacheReadTokens.toLocaleString()}`)
  console.log(`  Cache write tokens: ${cost.cacheWriteTokens.toLocaleString()}`)
  console.log(`  Total cost:         $${cost.totalCost.toFixed(4)}`)
  console.log(`  Cost/${perLabel}:${' '.repeat(Math.max(1, 14 - perLabel.length))}$${(cost.totalCost / cost.count).toFixed(4)}`)
  console.log(`  Duration:           ${totalTimeS.toFixed(1)}s`)
}

// ---------------------------------------------------------------------------
// Partial result persistence
// ---------------------------------------------------------------------------

/** Save partial results to a temp file for crash recovery. */
export function savePartialResults(partialPath: string, results: unknown[]): void {
  try {
    const partial = results.filter(Boolean)
    writeFileSync(partialPath, JSON.stringify(partial, null, 2))
  } catch {}
}

/** Remove the partial results file (call at end of successful run). */
export function cleanupPartialFile(partialPath: string): void {
  try { if (existsSync(partialPath)) rmSync(partialPath) } catch {}
}

// ---------------------------------------------------------------------------
// Detailed results output
// ---------------------------------------------------------------------------

/** Write detailed benchmark results JSON to a temp file. */
export function writeDetailedResults(
  benchmarkName: string,
  modelArg: string,
  extra: Record<string, unknown>,
): string {
  const suffix = Object.entries(extra)
    .filter(([k]) => k === 'split')
    .map(([, v]) => `-${v}`)
    .join('')
  const path = resolve(tmpdir(), `${benchmarkName}-results-${modelArg}${suffix}-${Date.now()}.json`)
  writeFileSync(path, JSON.stringify({
    benchmark: benchmarkName,
    model: MODEL_MAP[modelArg] || modelArg,
    timestamp: new Date().toISOString(),
    ...extra,
  }, null, 2))
  return path
}

// ---------------------------------------------------------------------------
// Error summary
// ---------------------------------------------------------------------------

/** Print a summary of errored results. */
export function printErrorSummary(errors: Array<{ id: string; error: string }>): void {
  if (errors.length === 0) return
  console.log('')
  console.log('ERRORS')
  console.log('-'.repeat(40))
  for (const e of errors) {
    console.log(`  ${e.id}: ${e.error.slice(0, 80)}`)
  }
}

// ---------------------------------------------------------------------------
// Fatal handler
// ---------------------------------------------------------------------------

/**
 * Wrap `main()` with a fatal error handler that cleans up Docker workers.
 * Call at the bottom of each benchmark runner script.
 */
export function runWithCleanup(
  main: () => Promise<void>,
  getWorkers: () => DockerWorker[],
  setWorkers: (ws: DockerWorker[]) => void,
): void {
  main().catch(err => {
    console.error('Fatal:', err)
    getWorkers().forEach(stopDockerWorker)
    setWorkers([])
    cleanupDockerEnvFile()
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Worker health / restart
// ---------------------------------------------------------------------------

/**
 * Check worker health and restart if unhealthy. Returns the (possibly new) worker.
 * Mutates `globalWorkers` via the provided setter.
 */
export async function ensureWorkerHealthy(
  worker: DockerWorker,
  workerId: number,
  workerConfig: DockerWorkerConfig,
  globalWorkers: DockerWorker[],
  setGlobalWorkers: (ws: DockerWorker[]) => void,
  verbose: boolean,
): Promise<DockerWorker> {
  if (await isWorkerHealthy(worker)) return worker

  if (verbose) console.log(`      [lifecycle] Worker ${workerId} unhealthy, restarting...`)
  stopDockerWorker(worker)
  await Bun.sleep(500)
  const fresh = await startDockerWorker(workerId, workerConfig)
  Object.assign(worker, fresh)
  setGlobalWorkers([...globalWorkers.filter(w => w.id !== workerId), worker])
  return worker
}

// ---------------------------------------------------------------------------
// Checkpoint save / load
// ---------------------------------------------------------------------------

import { REPO_ROOT } from './docker-worker'

const CHECKPOINT_BASE = resolve(REPO_ROOT, '.evals/checkpoints')

export interface CheckpointMeta {
  benchmark: string
  model: string
  accuracy: number
  iterations: number
  skills: string[]
  savedAt: string
}

/**
 * Save the agent's learned skills from the worker directory to a persistent
 * checkpoint. Returns the checkpoint directory path.
 */
export function saveCheckpoint(
  benchmark: string,
  workerDir: string,
  meta: { model: string; accuracy: number; iterations: number; skills: string[] },
): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `${benchmark}-${meta.model}-${meta.accuracy.toFixed(0)}pct-${ts}`
  const cpDir = resolve(CHECKPOINT_BASE, benchmark, name)
  const cpSkillsDir = join(cpDir, 'skills')
  mkdirSync(cpSkillsDir, { recursive: true })

  // Copy flat skills/*.md
  const srcSkills = join(workerDir, 'skills')
  if (existsSync(srcSkills)) {
    for (const f of readdirSync(srcSkills)) {
      cpSync(join(srcSkills, f), join(cpSkillsDir, f))
    }
  }

  // Copy native .shogo/skills/<name>/SKILL.md
  const srcShogo = join(workerDir, '.shogo', 'skills')
  const cpShogoDir = join(cpDir, '.shogo', 'skills')
  if (existsSync(srcShogo)) {
    mkdirSync(cpShogoDir, { recursive: true })
    for (const entry of readdirSync(srcShogo, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        cpSync(join(srcShogo, entry.name), join(cpShogoDir, entry.name), { recursive: true })
      }
    }
  }

  const checkpoint: CheckpointMeta = {
    benchmark,
    model: meta.model,
    accuracy: meta.accuracy,
    iterations: meta.iterations,
    skills: meta.skills,
    savedAt: new Date().toISOString(),
  }
  writeFileSync(join(cpDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2))

  return cpDir
}

/**
 * Load a checkpoint's skills into the worker directory.
 * Returns the list of skill filenames loaded.
 */
export function loadCheckpoint(cpPath: string, workerDir: string): string[] {
  const loaded: string[] = []

  // Restore flat skills/*.md
  const cpSkillsDir = join(cpPath, 'skills')
  if (existsSync(cpSkillsDir)) {
    const destSkills = join(workerDir, 'skills')
    mkdirSync(destSkills, { recursive: true })
    const files = readdirSync(cpSkillsDir).filter(f => f.endsWith('.md'))
    for (const f of files) {
      cpSync(join(cpSkillsDir, f), join(destSkills, f))
    }
    loaded.push(...files)
  }

  // Restore native .shogo/skills/<name>/
  const cpShogoDir = join(cpPath, '.shogo', 'skills')
  if (existsSync(cpShogoDir)) {
    const destShogo = join(workerDir, '.shogo', 'skills')
    mkdirSync(destShogo, { recursive: true })
    for (const entry of readdirSync(cpShogoDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        cpSync(join(cpShogoDir, entry.name), join(destShogo, entry.name), { recursive: true })
        loaded.push(`${entry.name}/SKILL.md`)
      }
    }
  }

  if (loaded.length === 0) {
    console.log(`  Warning: checkpoint has no skills: ${cpPath}`)
    return []
  }

  const metaPath = join(cpPath, 'checkpoint.json')
  if (existsSync(metaPath)) {
    const meta: CheckpointMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    console.log(`  Loaded checkpoint: ${meta.benchmark} ${meta.model} ${meta.accuracy?.toFixed(1)}% (${loaded.length} skills)`)
  } else {
    console.log(`  Loaded ${loaded.length} skills from checkpoint`)
  }

  return loaded
}

/**
 * Find the latest checkpoint for a given benchmark and optional model.
 * Returns the checkpoint directory path, or null if none found.
 */
export function getLatestCheckpoint(benchmark: string, model?: string): string | null {
  const benchDir = resolve(CHECKPOINT_BASE, benchmark)
  if (!existsSync(benchDir)) return null
  let dirs = readdirSync(benchDir)
    .filter(d => existsSync(join(benchDir, d, 'checkpoint.json')))
    .sort()
    .reverse()
  if (model) {
    const prefix = `${benchmark}-${model}`
    dirs = dirs.filter(d => d.startsWith(prefix))
  }
  return dirs.length > 0 ? resolve(benchDir, dirs[0]) : null
}

// ---------------------------------------------------------------------------
// Model name helper
// ---------------------------------------------------------------------------

export function resolveModelName(modelArg: string): string {
  return MODEL_MAP[modelArg] || modelArg
}

export function shogoModelName(modelArg: string): string {
  return `shogo-${resolveModelName(modelArg)}`
}
