// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Typed dispatcher for ambient runtime log entries (build / console /
 * canvas-error / exec). Every log producer in the runtime calls one of
 * the `record*` helpers; subscribers receive the same `RuntimeLogEntry`
 * shape over `/agent/runtime-logs/stream`.
 *
 * Why a dispatcher instead of growing `recordConsoleLogLine`: the
 * frontend "Output" tab needs to filter by source and surface
 * level=error counts as a red dot on the bottom panel. Crashing the
 * existing console-only path with a tagged-union body would break
 * back-compat for `/console-log/append`.
 */

export type RuntimeLogSource = 'console' | 'build' | 'canvas-error' | 'exec' | 'terminal'
export type RuntimeLogLevel = 'info' | 'warn' | 'error'

export interface RuntimeLogEntry {
  /** Monotonically increasing sequence number for `?since=<n>` polling. */
  seq: number
  /** Wall-clock millis when the entry was recorded. */
  ts: number
  source: RuntimeLogSource
  level: RuntimeLogLevel
  /** Visible payload; usually a single line, may include trailing newlines. */
  text: string
  /** Optional canvas surface id for `source: 'canvas-error'`. */
  surfaceId?: string
}

/** Hard cap on the in-memory ring buffer. Picked to match LogsPanel sizing. */
export const RUNTIME_LOG_RING_CAP = 1000

type Listener = (entry: RuntimeLogEntry) => void

const ring: RuntimeLogEntry[] = []
const listeners = new Set<Listener>()
let nextSeq = 1

function broadcast(entry: RuntimeLogEntry): void {
  ring.push(entry)
  if (ring.length > RUNTIME_LOG_RING_CAP) {
    ring.splice(0, ring.length - RUNTIME_LOG_RING_CAP)
  }
  for (const l of listeners) {
    try {
      l(entry)
    } catch {
      // Listeners are SSE handlers; one failing must not break the others.
    }
  }
}

export function recordRuntimeLogEntry(
  partial: Omit<RuntimeLogEntry, 'seq' | 'ts'> & { ts?: number },
): RuntimeLogEntry {
  const entry: RuntimeLogEntry = {
    seq: nextSeq++,
    ts: partial.ts ?? Date.now(),
    source: partial.source,
    level: partial.level,
    text: partial.text,
    surfaceId: partial.surfaceId,
  }
  broadcast(entry)
  return entry
}

/**
 * Console / runtime stdout/stderr lines emitted by Vite / Metro / app
 * processes. `stream === 'stderr'` upgrades the level to `'error'`.
 */
export function recordConsoleEntry(
  text: string,
  stream: 'stdout' | 'stderr' = 'stdout',
): RuntimeLogEntry {
  return recordRuntimeLogEntry({
    source: 'console',
    level: stream === 'stderr' ? 'error' : detectLevel(text, 'info'),
    text,
  })
}

/**
 * `PreviewManager` emits these for every `.build.log` write — install,
 * generate-prisma, db-push, build, start-api. Exit-code != 0 callers
 * pass `level: 'error'` so the Output tab can highlight failures.
 */
export function recordBuildEntry(
  text: string,
  level: RuntimeLogLevel = 'info',
): RuntimeLogEntry {
  return recordRuntimeLogEntry({
    source: 'build',
    level: level === 'info' ? detectLevel(text, 'info') : level,
    text,
  })
}

/**
 * Canvas surface threw a runtime error (uncaught exception, unhandled
 * rejection, hydration mismatch). Always level=error.
 */
export function recordCanvasErrorEntry(
  text: string,
  surfaceId: string | undefined,
): RuntimeLogEntry {
  return recordRuntimeLogEntry({
    source: 'canvas-error',
    level: 'error',
    text,
    surfaceId,
  })
}

/**
 * Best-effort heuristic for tagging a level when the caller didn't
 * specify one. We prefer false negatives (treat ambiguous lines as
 * `info`) so the unseen-error red dot stays meaningful.
 */
function detectLevel(text: string, fallback: RuntimeLogLevel): RuntimeLogLevel {
  if (/\berror\b|\bERR\b|\bfatal\b|\bFATAL\b|✖/i.test(text)) return 'error'
  if (/\bwarn(ing)?\b|⚠/i.test(text)) return 'warn'
  return fallback
}

export function subscribeRuntimeLogs(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export interface RuntimeLogsSnapshotOptions {
  since?: number
  sources?: ReadonlyArray<RuntimeLogSource>
  limit?: number
}

export function getRuntimeLogsSnapshot(
  opts: RuntimeLogsSnapshotOptions = {},
): RuntimeLogEntry[] {
  const { since, sources, limit } = opts
  let out = ring
  if (typeof since === 'number') {
    out = out.filter((e) => e.seq > since)
  }
  if (sources && sources.length > 0) {
    const set = new Set(sources)
    out = out.filter((e) => set.has(e.source))
  }
  if (typeof limit === 'number' && limit >= 0 && out.length > limit) {
    out = out.slice(out.length - limit)
  }
  return out.slice()
}

export function clearRuntimeLogsBuffer(): void {
  ring.length = 0
}

/** Test-only — drop everything. */
export function __resetRuntimeLogDispatcherForTest(): void {
  ring.length = 0
  listeners.clear()
  nextSeq = 1
}
