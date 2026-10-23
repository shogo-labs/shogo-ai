// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cache-efficiency baseline and non-regression gate.
 *
 * `run-eval --track cache-efficiency` writes ratios and prompt sizes; this
 * module turns them into `packages/agent-runtime/src/evals/cache-baseline.json` and compares a
 * later run against it. Kept free of I/O so both the CLI
 * (`scripts/cache-baseline.ts`) and the `cache-regression-gate` eval can use
 * the same thresholds, and so the gate itself is unit-tested (including the
 * negative case: a baseline hand-edited downward must fail).
 */
import type { EvalResult } from './types'
import { cacheHitRatio, median, prefixTokens, totalInputTokens } from './eval-helpers'

/** Fail when the weighted cache-hit ratio drops more than this many points. */
export const CACHE_GATE_RATIO_DROP_POINTS = 5
/** Fail when turn 1's prompt grows more than this fraction over the baseline. */
export const CACHE_GATE_TURN_TOKEN_GROWTH = 0.10

/**
 * Phase-A floors per ratio test. Also the gate's own floor: a baseline whose
 * ratio sits BELOW the floor for that test cannot be a genuine measurement of a
 * working cache, so it is treated as an edited baseline rather than as a target
 * to aim at. Without this, lowering the numbers in the JSON would be the easiest
 * way to make the gate green.
 */
export const CACHE_RATIO_FLOORS: Record<string, number> = {
  'cache-warm-repeat': 0.5,
  'cache-multiturn-history': 0.6,
  'cache-tool-loop': 0.5,
  'cache-compaction-recovery': 0.5,
  'cache-subagent-fork': 0.4,
}

export interface CacheBaselineEntry {
  /**
   * Cache-hit ratio of the LAST turn, 0..1. Deliberately not the run aggregate:
   * the first turn of an eval is always cold (it reads only whatever prefix a
   * previous session happened to persist), so an aggregate is mostly a measure
   * of how long the eval was. Steady state is what the gate should hold.
   */
  ratio: number
  /** Cache-hit ratio of turn 1 — recorded, never gated on (warm-up order). */
  firstTurnRatio: number
  /** Prompt tokens (uncached + cache-read + cache-write) of turn 1. */
  turnTokens: number
  /** Estimated prompt tokens of the run (stable + dynamic + tool schema). */
  prefixTokens: number
  /** Turns the ratio was measured over. */
  turns: number
}

export interface CacheBaseline {
  model: string
  /** ISO date the baseline was recorded. */
  date: string
  perTest: Record<string, CacheBaselineEntry>
  notes?: string
}

/**
 * One baseline per model, because the providers cache differently:
 * DeepSeek (hoshi) caches implicitly and best-effort with no breakpoint to set,
 * Anthropic (haiku/sonnet/opus) caches explicitly at our `cache_control`
 * breakpoints, and OpenAI (luna/sol) caches implicitly with its own TTL. A
 * ratio recorded on one says nothing about the others, so the file holds a
 * baseline per model and the gate picks the one matching the run.
 */
export interface CacheBaselineFile {
  models: Record<string, CacheBaseline>
}

/** The baseline recorded for `model`, or null when that model has none yet. */
export function selectBaseline(file: CacheBaselineFile | null | undefined, model: string): CacheBaseline | null {
  const entry = file?.models?.[model]
  return entry && entry.perTest ? entry : null
}

/** Model ids the file holds a baseline for, sorted — for messages and mismatch reports. */
export function recordedModelIds(file: CacheBaselineFile | null | undefined): string[] {
  const models = file?.models ?? {}
  return Object.keys(models)
    .filter((id) => models[id]?.perTest)
    .sort()
}

/**
 * What the gate can compare `model` against. Three outcomes because "no
 * baseline" means two different things: before anything is recorded it is the
 * expected first-run state, but once the file holds other models it is an
 * id mismatch (a renamed model, or the CLI id versus the id the run reported) —
 * and there, passing would mean comparing zero tests and reporting green.
 */
export type CacheBaselineLookup =
  | { status: 'ready'; baseline: CacheBaseline }
  | { status: 'empty' }
  | { status: 'model-missing'; recorded: string[] }

export function baselineFor(file: CacheBaselineFile | null | undefined, model: string): CacheBaselineLookup {
  const baseline = selectBaseline(file, model)
  if (baseline) return { status: 'ready', baseline }
  const recorded = recordedModelIds(file)
  return recorded.length === 0 ? { status: 'empty' } : { status: 'model-missing', recorded }
}

/** Insert or replace one model's baseline in the file. */
export function upsertBaseline(
  file: CacheBaselineFile | null | undefined,
  model: string,
  perTest: Record<string, CacheBaselineEntry>,
  date: string,
  notes?: string,
): CacheBaselineFile {
  return {
    models: {
      ...(file?.models ?? {}),
      [model]: { model, date, perTest, ...(notes ? { notes } : {}) },
    },
  }
}

export interface CacheGateRegression {
  test: string
  /** `baselineFloor` = the baseline itself is below the documented floor. */
  metric: 'ratio' | 'turnTokens' | 'baselineFloor'
  baseline: number
  current: number
  /** current - baseline, in the metric's own units (ratio is 0..1). */
  delta: number
}

export interface CacheGateResult {
  ok: boolean
  regressions: CacheGateRegression[]
  checked: number
  /** Set when no comparison was possible (no baseline yet, or no shared tests). */
  reason?: string
}

/** One eval result collapsed to the numbers the gate compares. */
export function cacheMetricsOf(result: EvalResult): CacheBaselineEntry {
  const turns = result.perTurnUsage ?? []
  const first = turns[0]
  const last = turns[turns.length - 1]
  return {
    ratio: last ? cacheHitRatio(last) : 0,
    firstTurnRatio: first ? cacheHitRatio(first) : 0,
    turnTokens: first ? totalInputTokens(first) : 0,
    prefixTokens: prefixTokens(result).total,
    turns: turns.length,
  }
}

/**
 * `run-eval --repeat N` reports each trial under its own id (`cache-warm-repeat#t1`,
 * `#t2`, …). Trials are samples of one test, so they share one baseline slot: the
 * bare id is what floors are keyed on and what a baseline must be written under,
 * otherwise a re-record through the documented `--repeat` path would store
 * `#t`-suffixed ids, every floor lookup would miss, and the
 * hand-edited-baseline protection would quietly stop applying.
 */
export function baseTestId(id: string): string {
  return id.replace(/#t\d+$/, '')
}

function medianEntry(entries: CacheBaselineEntry[]): CacheBaselineEntry {
  return {
    ratio: median(entries.map((e) => e.ratio)),
    firstTurnRatio: median(entries.map((e) => e.firstTurnRatio)),
    turnTokens: Math.round(median(entries.map((e) => e.turnTokens))),
    prefixTokens: Math.round(median(entries.map((e) => e.prefixTokens))),
    turns: Math.max(...entries.map((e) => e.turns)),
  }
}

/** Collapse `--repeat` trials onto their bare ids, taking the median of the trials. */
export function collapseTrials(perTest: Record<string, CacheBaselineEntry>): Record<string, CacheBaselineEntry> {
  const groups = new Map<string, CacheBaselineEntry[]>()
  for (const [id, entry] of Object.entries(perTest)) {
    const base = baseTestId(id)
    const group = groups.get(base)
    if (group) group.push(entry)
    else groups.set(base, [entry])
  }
  const out: Record<string, CacheBaselineEntry> = {}
  for (const [base, entries] of groups) out[base] = medianEntry(entries)
  return out
}

/** Build a baseline from one suite run's results, medianing `--repeat` trials. */
export function computeCacheBaseline(model: string, results: EvalResult[], date = new Date().toISOString()): CacheBaseline {
  const samples: Record<string, CacheBaselineEntry[]> = {}
  for (const result of results) {
    // Structural (no-LLM) tests have no tokens; they are gates on their own
    // criteria, not on a ratio.
    if ((result.perTurnUsage ?? []).length === 0) continue
    const id = baseTestId(result.eval.id)
    ;(samples[id] ??= []).push(cacheMetricsOf(result))
  }
  const perTest: Record<string, CacheBaselineEntry> = {}
  for (const [id, entries] of Object.entries(samples)) perTest[id] = medianEntry(entries)
  return { model, date, perTest }
}

/**
 * Compare a run against the baseline. A missing baseline is not a failure —
 * the first run records one — but a baseline the run can't match is.
 */
export function compareCacheBaseline(
  current: Record<string, CacheBaselineEntry>,
  baseline: CacheBaseline | null,
): CacheGateResult {
  if (!baseline) return { ok: true, regressions: [], checked: 0, reason: 'no baseline recorded yet' }
  // Both sides are collapsed onto bare ids first: a run recorded with
  // `--repeat` carries `test#t1`, `#t2`, … and every floor lookup would miss.
  const now = collapseTrials(current)
  const was = collapseTrials(baseline.perTest)
  const shared = Object.keys(now).filter((id) => was[id])
  if (shared.length === 0) {
    return { ok: true, regressions: [], checked: 0, reason: 'baseline has no test in common with this run' }
  }
  const regressions: CacheGateRegression[] = []
  // Refuse to gate against a baseline that cannot be a real measurement: a
  // hand-edited baseline is the one way to make every later run look healthy.
  for (const id of shared) {
    const floor = CACHE_RATIO_FLOORS[id]
    if (floor === undefined) continue
    if (was[id].ratio + 1e-9 < floor) {
      regressions.push({
        test: id,
        metric: 'baselineFloor',
        baseline: floor,
        current: was[id].ratio,
        delta: was[id].ratio - floor,
      })
    }
  }
  for (const id of shared) {
    const before = was[id]
    const after = now[id]
    const ratioDropPoints = (before.ratio - after.ratio) * 100
    if (ratioDropPoints > CACHE_GATE_RATIO_DROP_POINTS) {
      regressions.push({ test: id, metric: 'ratio', baseline: before.ratio, current: after.ratio, delta: after.ratio - before.ratio })
    }
    if (before.turnTokens > 0) {
      const growth = (after.turnTokens - before.turnTokens) / before.turnTokens
      if (growth > CACHE_GATE_TURN_TOKEN_GROWTH) {
        regressions.push({ test: id, metric: 'turnTokens', baseline: before.turnTokens, current: after.turnTokens, delta: after.turnTokens - before.turnTokens })
      }
    }
  }
  return { ok: regressions.length === 0, regressions, checked: shared.length }
}

/** Human-readable one-liner per regression, for eval criteria and CLI output. */
export function describeRegression(r: CacheGateRegression): string {
  if (r.metric === 'baselineFloor') {
    return `${r.test}: baseline ratio ${(r.current * 100).toFixed(1)}% is below the ${(r.baseline * 100).toFixed(1)}% floor — refusing to gate against an edited baseline`
  }
  if (r.metric === 'ratio') {
    return `${r.test}: cache-hit ratio ${(r.baseline * 100).toFixed(1)}% → ${(r.current * 100).toFixed(1)}% (${(r.delta * 100).toFixed(1)} pts)`
  }
  return `${r.test}: turn-1 prompt ${r.baseline.toLocaleString()} → ${r.current.toLocaleString()} tokens (+${((r.delta / r.baseline) * 100).toFixed(1)}%)`
}
