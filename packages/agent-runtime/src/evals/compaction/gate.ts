// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The gate a variant must pass before it may become the default (SHO-327).
 *
 * Modelled on `cache-baseline.ts`: pure functions over a recorded baseline so
 * the rule is unit-tested (including the hand-edited-baseline case) instead of
 * living in a CLI and being read by eye.
 *
 * A variant may become the default only if **all** of these hold against the
 * baseline (variant A, recorded from production behaviour):
 *  - it frees ≥ `MIN_EXTRA_FREED_POINTS` more wire context
 *  - `factRecall` and `nextActionMatch` stay within `MAX_QUALITY_DROP_POINTS`
 *  - `reReadRate` rises by at most `MAX_REREAD_RISE_POINTS`
 *  - the context-retention and cache-compaction-recovery tracks still pass
 */
import type { VariantSummary } from './types'

export const MIN_EXTRA_FREED_POINTS = 15
export const MAX_QUALITY_DROP_POINTS = 3
export const MAX_REREAD_RISE_POINTS = 10

/** Failing these numbers makes any variant ineligible, however much it frees. */
export const REQUIRED_TRACKS = ['context-retention', 'cache-compaction-recovery'] as const

/**
 * What a required track did in this run. `not-run` is not `pass`.
 *
 * The whole point of this guard is to stop a default flip on a run where the
 * supporting tracks never executed, so an absent result has to read as
 * missing — not as success by omission.
 */
export type TrackStatus = 'pass' | 'fail' | 'not-run'

/** Per-track outcome, for the report and the recorded baseline. */
export function trackStatuses(requiredTracks: Record<string, boolean> = {}): Record<string, TrackStatus> {
  const names = [...new Set<string>([...REQUIRED_TRACKS, ...Object.keys(requiredTracks)])]
  return Object.fromEntries(
    names.map((name) => {
      const recorded = requiredTracks[name]
      return [name, recorded === true ? 'pass' : recorded === false ? 'fail' : 'not-run']
    }),
  )
}

/**
 * Parse `--tracks context-retention=true,cache-compaction-recovery=false`.
 *
 * Only names the gate actually requires are accepted, and only `true`/`false`:
 * an unrecognised name or value throws rather than being dropped, because a
 * silently ignored flag is how a track ends up "not run" while the run looks
 * complete.
 */
export function parseRequiredTracks(raw: string | undefined, known: readonly string[] = REQUIRED_TRACKS): Record<string, boolean> {
  if (!raw) return {}
  const out: Record<string, boolean> = {}
  for (const entry of raw.split(',')) {
    const token = entry.trim()
    if (!token) continue
    const [name, value, ...rest] = token.split('=')
    if (!name || !token.includes('=') || rest.length > 0) {
      throw new Error(`--tracks: expected name=true|false, got "${token}"`)
    }
    if (!known.includes(name)) throw new Error(`--tracks: unknown track "${name}" (known: ${known.join(', ')})`)
    if (value !== 'true' && value !== 'false') throw new Error(`--tracks: "${name}" needs true or false, got "${value ?? ''}"`)
    out[name] = value === 'true'
  }
  return out
}

export interface CompactionBaseline {
  /** The summarizer model the baseline was recorded on. */
  model: string
  /** ISO date. */
  date: string
  /** Fixture count the run covered — a shrinking set is not a comparable run. */
  fixtures: number
  /** Variant A's numbers: what any candidate is compared to. */
  baseline: VariantSummary
  variants?: Record<string, VariantSummary>
  /** Which supporting tracks ran when this baseline was recorded, and how they did. */
  requiredTracks?: Record<string, boolean>
  notes?: string
}

export type GateReason =
  | 'frees-enough'
  | 'quality-drop'
  | 'reread-rise'
  | 'invented-tools'
  | 'external-track-failed'
  | 'external-track-not-run'
  | 'no-baseline'

export interface GateCheck {
  name: 'freedPct' | 'factRecall' | 'nextActionMatch' | 'reReadRate' | 'inventedTools' | 'requiredTracks'
  ok: boolean
  baseline: number | null
  candidate: number | null
  /** candidate - baseline, in the metric's own units. */
  delta: number | null
  detail: string
}

export interface GateResult {
  ok: boolean
  checks: GateCheck[]
  reasons: GateReason[]
}

export interface GateInput {
  summary: VariantSummary
  baseline: VariantSummary | null
  /**
   * Tracks that ran in this run, e.g. `{ 'context-retention': true }`. A track
   * that is absent never ran, and an unrun track fails the gate — the guard
   * exists to block a flip on evidence nobody collected.
   */
  requiredTracks?: Record<string, boolean>
}

/** Compare one variant against the recorded baseline. */
export function evaluateVariantGate({ summary, baseline, requiredTracks = {} }: GateInput): GateResult {
  const checks: GateCheck[] = []
  const reasons: GateReason[] = []

  if (!baseline) {
    return {
      ok: false,
      checks,
      reasons: ['no-baseline'],
    }
  }

  const freedDelta = summary.meanFreedPct - baseline.meanFreedPct
  checks.push({
    name: 'freedPct',
    ok: freedDelta >= MIN_EXTRA_FREED_POINTS,
    baseline: baseline.meanFreedPct,
    candidate: summary.meanFreedPct,
    delta: freedDelta,
    detail: `${freedDelta >= MIN_EXTRA_FREED_POINTS ? 'frees' : 'frees only'} ${freedDelta.toFixed(1)} points more (need ≥${MIN_EXTRA_FREED_POINTS})`,
  })
  if (freedDelta < MIN_EXTRA_FREED_POINTS) reasons.push('frees-enough')

  const recallDelta = (summary.meanFactRecall - baseline.meanFactRecall) * 100
  checks.push({
    name: 'factRecall',
    ok: recallDelta >= -MAX_QUALITY_DROP_POINTS,
    baseline: baseline.meanFactRecall * 100,
    candidate: summary.meanFactRecall * 100,
    delta: recallDelta,
    detail: `fact recall ${recallDelta >= 0 ? '+' : ''}${recallDelta.toFixed(1)} points (may drop ${MAX_QUALITY_DROP_POINTS})`,
  })
  if (recallDelta < -MAX_QUALITY_DROP_POINTS) reasons.push('quality-drop')

  const actionDelta = (summary.meanNextActionMatch - baseline.meanNextActionMatch) * 100
  checks.push({
    name: 'nextActionMatch',
    ok: actionDelta >= -MAX_QUALITY_DROP_POINTS,
    baseline: baseline.meanNextActionMatch * 100,
    candidate: summary.meanNextActionMatch * 100,
    delta: actionDelta,
    detail: `next-action match ${actionDelta >= 0 ? '+' : ''}${actionDelta.toFixed(1)} points (may drop ${MAX_QUALITY_DROP_POINTS})`,
  })
  if (actionDelta < -MAX_QUALITY_DROP_POINTS) reasons.push('quality-drop')

  const rereadDelta = (summary.meanReReadRate - baseline.meanReReadRate) * 100
  checks.push({
    name: 'reReadRate',
    ok: rereadDelta <= MAX_REREAD_RISE_POINTS,
    baseline: baseline.meanReReadRate * 100,
    candidate: summary.meanReReadRate * 100,
    delta: rereadDelta,
    detail: `re-read rate ${rereadDelta >= 0 ? '+' : ''}${rereadDelta.toFixed(1)} points (may rise ${MAX_REREAD_RISE_POINTS})`,
  })
  if (rereadDelta > MAX_REREAD_RISE_POINTS) reasons.push('reread-rise')

  checks.push({
    name: 'inventedTools',
    ok: summary.inventedTools === 0,
    baseline: baseline.inventedTools,
    candidate: summary.inventedTools,
    delta: summary.inventedTools - baseline.inventedTools,
    detail: `${summary.inventedTools} call(s) to a tool that was never offered`,
  })
  if (summary.inventedTools > 0) reasons.push('invented-tools')

  const statuses = trackStatuses(requiredTracks)
  const notRun = Object.entries(statuses).filter(([, s]) => s === 'not-run').map(([t]) => t)
  const failed = Object.entries(statuses).filter(([, s]) => s === 'fail').map(([t]) => t)
  checks.push({
    name: 'requiredTracks',
    // Fail closed: a track is satisfied only by a recorded pass.
    ok: notRun.length === 0 && failed.length === 0,
    baseline: null,
    candidate: null,
    delta: null,
    detail:
      failed.length > 0 || notRun.length > 0
        ? [
            failed.length > 0 ? `failing: ${failed.join(', ')}` : '',
            notRun.length > 0 ? `not run: ${notRun.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; ')
        : `required tracks pass (${Object.keys(statuses).join(', ')})`,
  })
  if (failed.length > 0) reasons.push('external-track-failed')
  if (notRun.length > 0) reasons.push('external-track-not-run')

  return { ok: checks.every((c) => c.ok), checks, reasons }
}
