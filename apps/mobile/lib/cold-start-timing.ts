// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cold-start timing recorder.
 *
 * Captures coarse-grained timing marks for the boot path from initial
 * navigation up through "project workspace is interactive". Intended
 * to be a low-overhead diagnostic — every mark just calls
 * `performance.now()` and pushes a string into an in-memory ring.
 *
 * The session is auto-flushed to the console (as a markdown-ish table)
 * once the project layout reports `runtime-ready`, or on explicit
 * `flush()`. The buffer is also exposed at
 * `globalThis.__shogoColdStart__` so it can be inspected from devtools
 * even before the auto-flush fires.
 *
 * Gated behind `EXPO_PUBLIC_SHOGO_COLD_START_TIMING !== '0'` so
 * production builds that explicitly opt out skip the cost. The default
 * is ON — the cost is in the noise (a handful of perf marks + one
 * console.table at boot).
 */

type Mark = {
  /** Stable identifier for this mark (e.g. "project:layout:mount"). */
  id: string
  /** When the mark was recorded, ms since `performance.timeOrigin`. */
  at: number
  /** Optional free-form context (request ids, retry counts, etc.). */
  meta?: Record<string, unknown>
}

const PERF_LOG_ENABLED =
  typeof process !== 'undefined' &&
  process.env?.EXPO_PUBLIC_SHOGO_PERF_LOG === '1'

const ENABLED =
  typeof process !== 'undefined' &&
  process.env?.EXPO_PUBLIC_SHOGO_COLD_START_TIMING !== '0'

const ORIGIN_MS = (() => {
  if (typeof performance === 'undefined') return Date.now()
  // `timeOrigin` is the navigation start; on web `performance.now()`
  // is "ms since timeOrigin". On native it's "ms since process start".
  // Both anchor a single monotonic clock for this session, which is
  // all we need for relative deltas.
  return performance.timeOrigin ?? Date.now()
})()

const marks: Mark[] = []
let autoFlushScheduled = false
/**
 * When set, the project layout has signalled "runtime ready" already.
 * Subsequent `mark()` calls past this point are still recorded (so
 * post-ready noise like first canvas frame is visible) but no longer
 * trigger another auto-flush.
 */
let flushedOnce = false
let openAttemptId: string | undefined

export function createOpenAttemptId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // Fall through to the dependency-free fallback.
  }
  return `open-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function setOpenAttemptId(id: string | undefined): void {
  openAttemptId = id
}

export function clearOpenAttemptId(id: string): void {
  if (openAttemptId === id) openAttemptId = undefined
}

function nowMs(): number {
  if (typeof performance === 'undefined') return Date.now() - ORIGIN_MS
  return performance.now()
}

export function mark(id: string, meta?: Record<string, unknown>): void {
  if (!ENABLED) return
  const enrichedMeta = openAttemptId ? { openAttemptId, ...meta } : meta
  const at = nowMs()
  marks.push({ id, at, meta: enrichedMeta })
  if (PERF_LOG_ENABLED) {
    // Keep this one-line and machine-readable so desktop logs can be joined
    // with the API/runtime phases without parsing console.table output.
    console.log(`[shogo-perf] ${JSON.stringify({
      perf: 'open',
      source: 'ui',
      id,
      openAttemptId,
      atMs: Math.round(at),
      wallTimeMs: Date.now(),
      meta: enrichedMeta,
    })}`)
  }
}

/**
 * Convenience helper that records `${id}:start` immediately and
 * returns a function the caller invokes when the work finishes,
 * which records `${id}:end` and an inline `${id}:dur=<ms>` mark.
 */
export function time(id: string, meta?: Record<string, unknown>): () => void {
  if (!ENABLED) return () => {}
  const start = nowMs()
  const enrichedMeta = openAttemptId ? { openAttemptId, ...meta } : meta
  marks.push({ id: `${id}:start`, at: start, meta: enrichedMeta })
  if (PERF_LOG_ENABLED) {
    console.log(`[shogo-perf] ${JSON.stringify({
      perf: 'open',
      source: 'ui',
      id: `${id}:start`,
      openAttemptId,
      atMs: Math.round(start),
      wallTimeMs: Date.now(),
      meta: enrichedMeta,
    })}`)
  }
  return () => {
    const end = nowMs()
    const endMeta = { ...enrichedMeta, durMs: end - start }
    marks.push({ id: `${id}:end`, at: end, meta: endMeta })
    if (PERF_LOG_ENABLED) {
      console.log(`[shogo-perf] ${JSON.stringify({
        perf: 'open',
        source: 'ui',
        id: `${id}:end`,
        openAttemptId,
        atMs: Math.round(end),
        wallTimeMs: Date.now(),
        meta: endMeta,
      })}`)
    }
  }
}

/**
 * Pretty-print the recorded marks as a console.table sorted by `at`,
 * with deltas vs. the previous mark. Returns the rows so callers (e.g.
 * the dev panel) can render them in-app.
 */
export function flush(reason: string = 'manual'): Array<{ at: string; dt: string; id: string; meta?: string }> {
  if (!ENABLED) return []
  const sorted = [...marks].sort((a, b) => a.at - b.at)
  const rows = sorted.map((m, i) => {
    const prev = i === 0 ? 0 : sorted[i - 1]!.at
    return {
      at: m.at.toFixed(1),
      dt: (m.at - prev).toFixed(1),
      id: m.id,
      meta: m.meta ? JSON.stringify(m.meta) : undefined,
    }
  })
  // `console.table` renders nicely in Chrome devtools / RN debugger.
  // We also emit a plain newline-separated log so the lines survive
  // copy-paste from terminals that don't capture console.table output.
  // eslint-disable-next-line no-console
  console.log(`[cold-start] flush(${reason}) — ${rows.length} marks`)
  // eslint-disable-next-line no-console
  console.table(rows)
  // eslint-disable-next-line no-console
  console.log(
    '[cold-start] textual log:\n' +
      rows
        .map((r) => `  ${r.at.padStart(8)}ms (+${r.dt.padStart(6)}ms) ${r.id}${r.meta ? ' ' + r.meta : ''}`)
        .join('\n'),
  )
  return rows
}

/**
 * Schedule a one-shot flush on the next microtask after the project
 * layout has reported `runtime-ready`. The defer lets a couple of
 * post-ready marks (canvas iframe mount, etc.) land in the same
 * table.
 */
export function markRuntimeReadyAndFlush(meta?: Record<string, unknown>): void {
  if (!ENABLED) return
  mark('project:runtime-ready', meta)
  if (flushedOnce) return
  flushedOnce = true
  if (autoFlushScheduled) return
  autoFlushScheduled = true
  // Give post-ready work one task tick to land its marks too.
  setTimeout(() => flush('runtime-ready'), 1000)
}

export function getMarks(): readonly Mark[] {
  return marks
}

export function reset(): void {
  marks.length = 0
  autoFlushScheduled = false
  flushedOnce = false
  openAttemptId = undefined
}

if (ENABLED && typeof globalThis !== 'undefined') {
  ;(globalThis as { __shogoColdStart__?: unknown }).__shogoColdStart__ = {
    mark,
    time,
    flush,
    getMarks,
    reset,
  }
}

// Record the module-load mark immediately. Anything that imports this
// file early in the boot (e.g. the root `_layout.tsx`) will anchor the
// timeline against this point.
mark('cold-start:module-load')
