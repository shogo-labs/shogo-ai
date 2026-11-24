// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The watch window a rootfs activation opens, and the decision to roll it back
 * (SHO-552).
 *
 * On 2026-11-23 staging activated rootfs `718a651` (no `fc-init`) and every
 * cold boot on the host failed for an hour. The static gates that followed
 * (SHO-549) catch a missing guest init, but nothing caught an image that is
 * present, executable and still cannot serve a VM — and the rename that put it
 * live had already destroyed the image that could.
 *
 * So an activation now keeps the outgoing generation (`<base>.prev`) and opens a
 * short watch. The pool reports every cold boot it starts from the live image;
 * this decides, from those counts alone, whether the fleet is better on the
 * image we just left.
 *
 * Everything here is pure or takes its directory explicitly, so the policy can
 * be pinned by tests without touching `/opt/metal-agent`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Default watch window after an activation (METAL_ROOTFS_WATCH_MS). */
export const DEFAULT_WATCH_MS = 15 * 60_000
/** Cold-boot failures inside the window before a rollback is even considered. */
export const DEFAULT_MIN_FAILURES = 5
/** …and the failure rate they must exceed: more failures than successes. */
export const DEFAULT_ROLLBACK_RATE = 0.5

export const WATCH_MARKER = 'ROOTFS_WATCH'
export const PREV_MARKER = 'ROOTFS_PREV'
export const BAD_MARKER = 'ROOTFS_BAD'
/** The bad list is a diagnostic, not a ledger: the last N is plenty. */
export const BAD_CAP = 20

/** A rootfs that is live and on probation: roll back if it cannot boot VMs. */
export interface RootfsWatch {
  /** Generation now serving. */
  version: string
  /** Generation it replaced — what a rollback goes back to. */
  prevVersion: string | null
  activatedAt: number
  /** End of the watch; a failure after this is not counted. */
  until: number
}

/**
 * The generation an activation displaced. Written BEFORE the rename, because
 * after it the outgoing image's revision and identity are gone with it.
 */
export interface RootfsPrevious {
  version: string | null
  revision: string | null
  /** Rootfs identities (snapshot-compatibility keys) of the outgoing images. */
  identities: { standard?: string; docker?: string }
  activatedAt: number
}

/** A generation proven not to boot, so it is never rebuilt or re-applied. */
export interface BadRootfs {
  version: string
  revision: string | null
  reason: string
  at: number
}

export type RollbackDecision = 'ok' | 'rollback' | 'expired'

/**
 * Pure: is the watched generation earning its place?
 *
 * `rollback` needs BOTH a floor (5 failures — one wedged project is not a bad
 * image) and a majority (more failures than successes — a host that is merely
 * busy booting still answers /health eventually). Either alone rolls back on
 * normal churn: 5 failures among 20 boots is a healthy host having a bad minute.
 */
export function rollbackDecision(input: {
  failures: number
  successes: number
  now: number
  watch: RootfsWatch | null
  minFailures?: number
  rate?: number
}): RollbackDecision {
  const { failures, successes, now, watch } = input
  const minFailures = input.minFailures ?? DEFAULT_MIN_FAILURES
  const rate = input.rate ?? DEFAULT_ROLLBACK_RATE
  if (!watch) return 'ok'
  if (now >= watch.until) return 'expired'
  const total = failures + successes
  if (failures < minFailures) return 'ok'
  if (!(failures / total > rate)) return 'ok'
  return 'rollback'
}

/** Is this generation (version or stamped revision) on the bad list? */
export function findBadRootfs(
  list: BadRootfs[],
  version: string | null | undefined,
  revision?: string | null,
): BadRootfs | null {
  for (const e of list) {
    if (version && e.version === version) return e
    if (revision && e.revision && e.revision === revision) return e
  }
  return null
}

/**
 * Most recent first, one entry per version, capped. A repeat replaces its
 * earlier entry rather than growing the list — the reason from the latest
 * failure is the one worth reading.
 */
export function addBadRootfs(list: BadRootfs[], entry: BadRootfs, cap = BAD_CAP): BadRootfs[] {
  const rest = list.filter((e) => e.version !== entry.version)
  return [entry, ...rest].slice(0, cap)
}

export function readWatch(dir: string): RootfsWatch | null {
  const m = readJson<RootfsWatch>(dir, WATCH_MARKER)
  return m?.version && typeof m.until === 'number' ? m : null
}

export function writeWatch(dir: string, watch: RootfsWatch): void {
  writeJson(dir, WATCH_MARKER, watch)
}

export function clearWatch(dir: string): void {
  clearMarker(dir, WATCH_MARKER)
}

export function readPrevious(dir: string): RootfsPrevious | null {
  const m = readJson<RootfsPrevious>(dir, PREV_MARKER)
  return m && typeof m.activatedAt === 'number' ? m : null
}

export function writePrevious(dir: string, prev: RootfsPrevious): void {
  writeJson(dir, PREV_MARKER, prev)
}

export function clearPrevious(dir: string): void {
  clearMarker(dir, PREV_MARKER)
}

export function readBadList(dir: string): BadRootfs[] {
  const m = readJson<BadRootfs[]>(dir, BAD_MARKER)
  return Array.isArray(m) ? m.filter((e) => e && typeof e.version === 'string') : []
}

export function writeBadList(dir: string, list: BadRootfs[]): void {
  writeJson(dir, BAD_MARKER, list.slice(0, BAD_CAP))
}

/** Most recently rejected generation, for the heartbeat's `rootfsRejected`. */
export function latestBadRootfs(dir: string): BadRootfs | null {
  return readBadList(dir)[0] ?? null
}

export function isPreviousImageOnDisk(base: string): boolean {
  return !!base && existsSync(`${base}.prev`)
}

// --- cold-boot ledger ---------------------------------------------------------

export interface ColdBootCounts {
  failures: number
  successes: number
  /** The failure seen most often since the cutoff — the one line worth logging. */
  topError: string | null
}

export interface ColdBootEvent {
  at: number
  ok: boolean
  error?: string
}

/**
 * What the pool saw: one entry per cold boot started from the LIVE image.
 * Snapshot restores and the activation boot-probe are not cold boots from the
 * live image and must not be recorded — a probe failing is already fatal on its
 * own, and a restore was never at risk.
 *
 * Bounded: a busy host boots hundreds of VMs during a watch window and the
 * counts are all that is ever read.
 */
export class ColdBootLedger {
  private events: ColdBootEvent[] = []

  constructor(private cap = 500) {}

  record(ok: boolean, error?: string, at = Date.now()): void {
    this.events.push({ at, ok, ...(ok ? {} : { error: error ?? 'unknown error' }) })
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap)
  }

  reset(): void {
    this.events = []
  }

  counts(since = 0): ColdBootCounts {
    let failures = 0
    let successes = 0
    const byError = new Map<string, number>()
    for (const e of this.events) {
      if (e.at < since) continue
      if (e.ok) {
        successes++
        continue
      }
      failures++
      const key = e.error ?? 'unknown error'
      byError.set(key, (byError.get(key) ?? 0) + 1)
    }
    let topError: string | null = null
    let best = 0
    for (const [msg, n] of byError) {
      if (n > best) {
        best = n
        topError = msg
      }
    }
    return { failures, successes, topError }
  }

  size(): number {
    return this.events.length
  }
}

// --- marker IO ----------------------------------------------------------------

function readJson<T>(dir: string, name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(dir: string, name: string, value: unknown): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), JSON.stringify(value))
  } catch (err: any) {
    console.warn(`[self-update] could not write ${name}:`, err?.message ?? err)
  }
}

function clearMarker(dir: string, name: string): void {
  rmSync(join(dir, name), { force: true })
}
