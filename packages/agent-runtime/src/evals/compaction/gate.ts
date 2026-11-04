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
  notes?: string
}

export type GateReason =
  | 'frees-enough'
  | 'quality-drop'
  | 'reread-rise'
  | 'invented-tools'
  | 'external-track-failed'
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
  /** Tracks that must still pass, e.g. `{ 'context-retention': true }`. */
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

  const failedTracks = REQUIRED_TRACKS.filter((t) => requiredTracks[t] === false)
  checks.push({
    name: 'requiredTracks',
    ok: failedTracks.length === 0,
    baseline: null,
    candidate: null,
    delta: null,
    detail: failedTracks.length === 0
      ? `required tracks pass (${REQUIRED_TRACKS.join(', ')})`
      : `failing: ${failedTracks.join(', ')}`,
  })
  if (failedTracks.length > 0) reasons.push('external-track-failed')

  return { ok: checks.every((c) => c.ok), checks, reasons }
}
