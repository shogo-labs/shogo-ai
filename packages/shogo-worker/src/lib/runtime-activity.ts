// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "is this runtime busy?" decision, shared by every eviction path.
 *
 * Before this, each pool (background LRU, preview LRU, the worker's global
 * `maxRuntimes` LRU) called a live HTTP probe at eviction time and read
 * "could not tell" as "idle". On a host saturated by builds that probe timed
 * out and the host kept killing runtimes that were running tasks: one
 * Windows desktop evicted a background runtime 146 times in 24h while keeping
 * one 0 times (SHO-143).
 *
 * Three rules fix that, and they live here rather than in each manager:
 *
 *   1. The decision reads a CACHED activity sample, never a probe taken while
 *      the host is deciding to kill something. A sample older than
 *      {@link ACTIVITY_STALE_MS} is not evidence of idleness.
 *   2. Unknown is BUSY. No sample, a failed probe, a stale sample, a runtime
 *      that is still starting — all mean "keep", because killing it might kill
 *      work we simply could not see.
 *   3. Only provably-dead runtimes are reaped: the process exited, or the
 *      runtime refused connections for longer than {@link DEAD_PROBE_MS}.
 *
 * This module is pure (no I/O, no imports) so both the worker manager and the
 * desktop API manager decide identically and it can be unit-tested directly.
 */

/** How often each running runtime's activity is re-read. */
export const ACTIVITY_SAMPLE_MS = 10 * 1000

/**
 * A sample older than this is re-read once more before a runtime is killed.
 *
 * The timer above keeps the cache warm, but a turn can start inside the gap
 * between two samples. Two seconds bounds "we killed work that began a moment
 * ago" without turning the decision back into a probe on the critical path —
 * and because a failed probe now reads as `unknown` (keep), re-asking is
 * never the reason a runtime dies.
 */
export const ACTIVITY_RESAMPLE_BEFORE_EVICT_MS = 2 * 1000

/**
 * A sample older than this is not evidence of anything. Three missed samples
 * (rather than one) keeps a host that is briefly CPU-starved from reading as
 * "idle" — which is exactly how the 146 evictions happened.
 */
export const ACTIVITY_STALE_MS = 30 * 1000

/** A runtime that has not finished starting is never an eviction victim. */
export const STARTUP_GRACE_MS = 2 * 60 * 1000

/** Refusing connections for this long means the runtime is dead, not busy. */
export const DEAD_PROBE_MS = 60 * 1000

export interface ActivityCounts {
  /** Agent turns in flight (chat, schedule, heartbeat, channel). */
  turns: number
  /** Registry tasks still running, whether or not they will notify. */
  tasks: number
  /** Open response streams. */
  streams: number
  /** Live child processes of the runtime's execs. */
  children: number
}

export const ZERO_COUNTS: ActivityCounts = { turns: 0, tasks: 0, streams: 0, children: 0 }

/**
 * One cached reading of a runtime's own activity. `ok: false` means the last
 * probe failed — the counts are then the last known values, kept only for the
 * log line; the decision treats the sample as unknown.
 */
export interface ActivitySample {
  counts: ActivityCounts
  /** When the host observed this reading (epoch ms). */
  at: number
  ok: boolean
  error?: string
  /** First failure of the current run of failures, epoch ms. */
  failingSince?: number | null
}

export type BusyReason =
  | 'terminal'
  | 'inflight-call'
  | 'grace'
  | 'unknown'
  | 'stale'
  | 'work'
  | 'idle'
  | 'dead'

export interface BusyDecision {
  /** Never evict while true. */
  busy: boolean
  /** Provably gone: reap it, don't evict it. */
  dead: boolean
  reason: BusyReason
  counts: ActivityCounts
  /** Age of the sample the decision was made from, when there is one. */
  sampleAgeMs?: number
  /** `turns=0 tasks=2 streams=0 children=0`, for the decision log line. */
  countsText: string
}

export interface DecideBusyInput {
  /** Epoch ms "now". */
  now: number
  /** When the runtime process was started, epoch ms. */
  startedAt: number
  /** Worker/API status string for the runtime ('running', 'starting', …). */
  status: string
  /** The cached activity reading, if there is one. */
  sample?: ActivitySample | null
  /** Open PTY terminals attached to this runtime. */
  terminalSessions?: number
  /** In-flight project calls / card hand-offs targeting this runtime. */
  inflightCalls?: number
  /** The runtime's process has exited (code or signal). */
  processExited?: boolean
  startupGraceMs?: number
  staleMs?: number
  deadAfterMs?: number
}

export function countsText(counts: ActivityCounts): string {
  return `turns=${counts.turns} tasks=${counts.tasks} streams=${counts.streams} children=${counts.children}`
}

export function totalWork(counts: ActivityCounts): number {
  return counts.turns + counts.tasks + counts.streams + counts.children
}

function decision(
  busy: boolean,
  dead: boolean,
  reason: BusyReason,
  counts: ActivityCounts,
  sampleAgeMs?: number,
): BusyDecision {
  return { busy, dead, reason, counts, countsText: countsText(counts), ...(sampleAgeMs != null ? { sampleAgeMs } : {}) }
}

/**
 * Decide whether a runtime may be evicted. Order matters: the cheap, certain
 * "someone is working" signals come first, then anything we cannot verify
 * (which keeps the runtime), and only then idle.
 */
export function decideBusy(input: DecideBusyInput): BusyDecision {
  const {
    now,
    startedAt,
    status,
    sample,
    processExited = false,
    startupGraceMs = STARTUP_GRACE_MS,
    staleMs = ACTIVITY_STALE_MS,
    deadAfterMs = DEAD_PROBE_MS,
  } = input
  const terminalSessions = input.terminalSessions ?? 0
  const inflightCalls = input.inflightCalls ?? 0
  const counts = sample?.counts ?? ZERO_COUNTS
  const sampleAgeMs = sample ? Math.max(0, now - sample.at) : undefined

  // A shell attached to this runtime is the strongest "someone is working"
  // signal there is (SHO-107) — evicting it kills their terminal mid-command.
  if (terminalSessions > 0) return decision(true, false, 'terminal', counts, sampleAgeMs)
  if (inflightCalls > 0) return decision(true, false, 'inflight-call', counts, sampleAgeMs)

  // Provably gone. Reaped as dead, not evicted.
  if (processExited) return decision(false, true, 'dead', counts, sampleAgeMs)

  // Still booting: the gateway is not up, so no probe could see its work yet.
  if (status === 'starting' || status === 'restarting') {
    return decision(true, false, 'grace', counts, sampleAgeMs)
  }
  const age = now - (startedAt || now)
  if (age >= 0 && age < startupGraceMs) return decision(true, false, 'grace', counts, sampleAgeMs)

  if (status !== 'running') {
    // Neither running nor provably dead — we cannot see it, so keep it.
    return decision(true, false, 'unknown', counts, sampleAgeMs)
  }

  if (!sample) return decision(true, false, 'unknown', counts, sampleAgeMs)
  if (!sample.ok) {
    const failingFor = sample.failingSince != null ? now - sample.failingSince : 0
    // A runtime that refuses connections is dead once it has done so for long
    // enough that a hung-but-working runtime would have answered.
    if (failingFor >= deadAfterMs) return decision(false, true, 'dead', counts, sampleAgeMs)
    return decision(true, false, 'unknown', counts, sampleAgeMs)
  }
  if ((sampleAgeMs ?? 0) > staleMs) return decision(true, false, 'stale', counts, sampleAgeMs)
  if (totalWork(counts) > 0) return decision(true, false, 'work', counts, sampleAgeMs)
  return decision(false, false, 'idle', counts, sampleAgeMs)
}

/** Human phrase for the `keeping`/`evicting` log line. */
export function describeBusyReason(d: BusyDecision, idleMs?: number): string {
  switch (d.reason) {
    case 'terminal':
      return 'open terminal'
    case 'inflight-call':
      return 'in-flight project call'
    case 'grace':
      return 'starting up'
    case 'unknown':
      return `unknown activity${d.sampleAgeMs != null ? ` (last sample ${Math.round(d.sampleAgeMs / 1000)}s old)` : ' (no sample yet)'}`
    case 'stale':
      return `stale activity (last sample ${Math.round((d.sampleAgeMs ?? 0) / 1000)}s old)`
    case 'work':
      return d.countsText
    case 'dead':
      return 'process gone'
    case 'idle':
      return idleMs != null ? `idle ${Math.round(idleMs / 60_000)}m, ${d.countsText}` : `idle, ${d.countsText}`
  }
}
