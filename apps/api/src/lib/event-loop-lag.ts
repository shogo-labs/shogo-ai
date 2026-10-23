// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Event-loop lag monitor for the local API (SHO-185).
 *
 * The production symptom was a tunnel dropping with 1006 while the machine was
 * healthy: something on this API's own event loop ran synchronously for ~600ms
 * (a shelled-out `lsof`/`ps` on the runtime start path), so `/health` could not
 * answer and the desktop supervisor killed the API after three missed probes.
 *
 * A blocked loop cannot warn about itself *while* it is blocked, so this fires
 * the moment the timer its own interval scheduled comes back late. That is the
 * fingerprint to look for next time a tunnel dies without an error: a
 * `[LocalApi] event loop blocked for Nms` line immediately before the drop.
 */

export interface LagSample {
  /** How late the tick was: the time the loop spent blocked. */
  lagMs: number
  at: number
}

export interface LagMonitorOptions {
  intervalMs?: number
  /** Ticks later than this are reported. */
  thresholdMs?: number
  /** Minimum gap between reports, so one long stall doesn't log repeatedly. */
  minReportGapMs?: number
  onLag?: (sample: LagSample) => void
}

export interface LagMonitorHandle {
  stop: () => void
  /** Samples seen since start (for tests and the local diagnostics route). */
  samples: LagSample[]
}

const DEFAULT_INTERVAL_MS = 1_000
const DEFAULT_THRESHOLD_MS = 500
const DEFAULT_MIN_REPORT_GAP_MS = 5_000

export function startEventLoopLagMonitor(options: LagMonitorOptions = {}): LagMonitorHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS
  const minReportGapMs = options.minReportGapMs ?? DEFAULT_MIN_REPORT_GAP_MS

  const samples: LagSample[] = []
  let stopped = false
  let lastReportAt = 0
  let expectedAt = Date.now() + intervalMs

  const timer = setInterval(() => {
    if (stopped) return
    const now = Date.now()
    const lagMs = now - expectedAt
    expectedAt = now + intervalMs
    if (lagMs < thresholdMs) return

    const sample: LagSample = { lagMs, at: now }
    samples.push(sample)
    if (samples.length > 50) samples.shift()

    // One report per stall window: a 30s freeze must not queue 30 lines.
    if (now - lastReportAt >= minReportGapMs) {
      lastReportAt = now
      console.warn(`[LocalApi] event loop blocked for ${Math.round(lagMs)}ms`)
    }
    options.onLag?.(sample)
  }, intervalMs)

  // A diagnostics timer must never keep the process alive on its own.
  ;(timer as unknown as { unref?: () => void })?.unref?.()

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
    samples,
  }
}
