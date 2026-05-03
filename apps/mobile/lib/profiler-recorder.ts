// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Lightweight profiler recorder for the chat-streaming harness.
 *
 * The React DevTools Profiler is the source of truth for visual analysis,
 * but on native we don't always have the standalone GUI attached and we
 * still want a textual snapshot we can copy into a perf write-up. This
 * module collects every <Profiler onRender> commit into an in-memory ring
 * buffer and exposes a `summarize()` helper.
 *
 * Dev-only — never imported from production code paths.
 */

import type { ProfilerOnRenderCallback } from 'react'

declare const __DEV__: boolean

export interface CommitRecord {
  /** Profiler `id` prop that fired this commit. */
  id: string
  /** "mount" or "update". */
  phase: 'mount' | 'update' | 'nested-update'
  /** Time spent rendering the committed update (ms). */
  actualDuration: number
  /** Estimated time to render the entire subtree without memo (ms). */
  baseDuration: number
  /** When React began processing this update (ms since perf origin). */
  startTime: number
  /** When this update was committed (ms since perf origin). */
  commitTime: number
}

const MAX_COMMITS = 5_000

class Recorder {
  private commits: CommitRecord[] = []
  private enabled = false

  reset(): void {
    this.commits = []
  }

  start(): void {
    this.enabled = true
    this.reset()
  }

  stop(): void {
    this.enabled = false
  }

  isRecording(): boolean {
    return this.enabled
  }

  record: ProfilerOnRenderCallback = (
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  ) => {
    if (!this.enabled) return
    if (this.commits.length >= MAX_COMMITS) return
    this.commits.push({
      id,
      phase: phase as CommitRecord['phase'],
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
    })
  }

  all(): readonly CommitRecord[] {
    return this.commits
  }

  /**
   * Aggregate per-id metrics for the current recording. Useful for printing
   * a quick text summary alongside the DevTools Profiler export.
   */
  summarize(): {
    totalCommits: number
    perId: Record<
      string,
      {
        commitCount: number
        actualMs: { sum: number; mean: number; p50: number; p95: number; max: number }
        baseMs: { sum: number; mean: number; p50: number; p95: number; max: number }
      }
    >
  } {
    const buckets = new Map<string, { actuals: number[]; bases: number[] }>()

    for (const c of this.commits) {
      let b = buckets.get(c.id)
      if (!b) {
        b = { actuals: [], bases: [] }
        buckets.set(c.id, b)
      }
      b.actuals.push(c.actualDuration)
      b.bases.push(c.baseDuration)
    }

    const perId: Record<string, ReturnType<Recorder['summarize']>['perId'][string]> = {}

    for (const [id, b] of buckets) {
      perId[id] = {
        commitCount: b.actuals.length,
        actualMs: stats(b.actuals),
        baseMs: stats(b.bases),
      }
    }

    return { totalCommits: this.commits.length, perId }
  }
}

function stats(xs: number[]): { sum: number; mean: number; p50: number; p95: number; max: number } {
  if (xs.length === 0) {
    return { sum: 0, mean: 0, p50: 0, p95: 0, max: 0 }
  }
  const sorted = [...xs].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, x) => acc + x, 0)
  const mean = sum / sorted.length
  const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    sum,
    mean,
    p50: p(0.5),
    p95: p(0.95),
    max: sorted[sorted.length - 1],
  }
}

export const profilerRecorder = new Recorder()

// Expose to globalThis in dev so it can be poked from the browser console
// or react-native-debugger.
if (__DEV__) {
  ;(globalThis as { __shogoProfilerRecorder__?: Recorder }).__shogoProfilerRecorder__ =
    profilerRecorder
}
