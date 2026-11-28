// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure GC policy: given the current disk state and the set of evictable
 * suspended snapshots, decide WHICH projects to evict (LRU) and HOW FAR to go
 * (down to the low watermark and/or under the cache byte cap). Kept free of any
 * I/O or VM state so it is exhaustively unit-testable — the pool wires the real
 * artifacts and side effects around it.
 */

export interface EvictionCandidate {
  projectId: string
  /** Actual NVMe bytes this snapshot occupies (allocated blocks). */
  bytes: number
  /** Recency for LRU ordering (ms epoch); oldest evicted first. */
  lastAccessAt: number
  /** Only durably-backed snapshots may be evicted (else we'd lose the only copy). */
  durableBacked: boolean
  /** In-flight (assign/resume/suspend) — never evict mid-operation. */
  inFlight: boolean
}

export interface GcInputs {
  usedBytes: number
  totalBytes: number
  /** Sum of bytes across the local snapshot cache (for the optional byte cap). */
  cacheBytes: number
  candidates: EvictionCandidate[]
  highPct: number
  lowPct: number
  /**
   * Reclaim at this used% *before* the alert line: the page fires at
   * `METAL_DISK_HIGH_PCT` (85), so a volume that fills slowly otherwise lives
   * 0.n points under a page forever, never reclaiming. 0 = off (the old
   * behaviour: only the alert watermark or the byte cap triggers).
   */
  headroomPct?: number
  /**
   * Most bytes a single headroom sweep may reclaim. 0/undefined = no limit.
   *
   * A headroom target is not always reachable: on a 175 TB NVMe volume four
   * points is terabytes while the whole snapshot cache is a few hundred GB, so
   * "evict until used < headroom" would drain the entire warm pool on the first
   * sweep and every sweep after it. The honest thing to do below the alert line
   * is trim — the oldest cache entries, bounded — and let the watermark path
   * above the line free whatever it takes.
   */
  headroomBudgetBytes?: number
  /** 0 = disabled. */
  cacheMaxBytes: number
  /** Force eviction of everything evictable regardless of watermarks. */
  force?: boolean
}

/** Why a sweep evicted: which limit it crossed. Reported on the metric and the log. */
export type GcTrigger = 'force' | 'watermark' | 'headroom' | 'cap'

export interface GcDecision {
  /** True if the sweep should evict (pressure crossed, cap exceeded, or forced). */
  triggered: boolean
  /** Which constraint fired; null when nothing did. */
  trigger: GcTrigger | null
  /** projectIds to evict, in eviction order (LRU first). */
  evict: string[]
  /** Bytes expected to be reclaimed. */
  plannedBytes: number
  /** Candidates that were eligible at all (diagnosis: a trigger with 0 of these can never reclaim). */
  evictableCount: number
}

/** projects eligible for eviction, oldest-access first. */
function evictable(candidates: EvictionCandidate[]): EvictionCandidate[] {
  return candidates
    .filter((c) => c.durableBacked && !c.inFlight)
    .sort((a, b) => a.lastAccessAt - b.lastAccessAt)
}

/**
 * The configured headroom, or 0 when it is not usable.
 *
 * A headroom outside (lowPct, highPct) is ignored rather than obeyed: at or
 * above `highPct` it is meaningless (the alert watermark fires first), and at or
 * below `lowPct` it would make every sweep flush the whole cache down to the
 * low watermark — the opposite of a quiet trim. `diskHighPct >= 100` means disk
 * pressure is switched off entirely, so the headroom is off with it.
 */
export function headroomPctFor(cfg: { gcHeadroomPct: number; diskLowPct: number; diskHighPct: number }): number {
  const pct = cfg.gcHeadroomPct
  if (!Number.isFinite(pct) || pct <= 0) return 0
  if (cfg.diskHighPct >= 100) return 0
  if (pct <= cfg.diskLowPct || pct >= cfg.diskHighPct) return 0
  return pct
}

/**
 * Decide the eviction set.
 *
 * Triggers, in severity order: forced; disk at/over the high watermark (bring
 * used% back to low); disk at/over the headroom watermark (bring used% back
 * under the headroom — reclaim BEFORE the page, not at it); cache bytes over
 * the cap. Eviction stops as soon as the constraint that fired is satisfied.
 */
export function planEvictions(inp: GcInputs): GcDecision {
  const usedPct = inp.totalBytes > 0 ? (inp.usedBytes / inp.totalBytes) * 100 : 0
  const headroomPct = inp.headroomPct ?? 0
  const overWatermark = usedPct >= inp.highPct
  // Only meaningful below the alert line; at 85 the watermark path governs and
  // evicts further (to low), which is the existing behaviour.
  const overHeadroom = !overWatermark && headroomPct > 0 && usedPct >= headroomPct
  const overCap = inp.cacheMaxBytes > 0 && inp.cacheBytes > inp.cacheMaxBytes

  const eligible = evictable(inp.candidates)

  if (!inp.force && !overWatermark && !overHeadroom && !overCap) {
    return { triggered: false, trigger: null, evict: [], plannedBytes: 0, evictableCount: eligible.length }
  }

  const trigger: GcTrigger = inp.force
    ? 'force'
    : overWatermark
      ? 'watermark'
      : overHeadroom
        ? 'headroom'
        : 'cap'

  // What used% the sweep aims for: the low watermark when the alert line was
  // crossed, otherwise just back under the trigger (a headroom reclaim is a trim,
  // not a flush). The cap-only case keeps the old target, which is already
  // satisfied on a healthy disk, so only the cap governs there.
  const targetPct = overWatermark ? inp.lowPct : overHeadroom ? headroomPct : inp.lowPct
  const targetBytes = (targetPct / 100) * inp.totalBytes
  // A trim below the alert line is bounded: see headroomBudgetBytes. It applies
  // only when the headroom trigger is the one that fired — once the watermark is
  // crossed there is no budget, by design.
  const budget =
    trigger === 'headroom' && inp.headroomBudgetBytes && inp.headroomBudgetBytes > 0
      ? inp.headroomBudgetBytes
      : Infinity
  let used = inp.usedBytes
  let cache = inp.cacheBytes
  const evict: string[] = []
  let plannedBytes = 0

  for (const c of eligible) {
    const diskSatisfied = inp.totalBytes === 0 || used <= targetBytes
    const capSatisfied = inp.cacheMaxBytes <= 0 || cache <= inp.cacheMaxBytes
    // When forced, drain everything evictable; otherwise stop once both are met.
    if (!inp.force && diskSatisfied && capSatisfied) break
    if (plannedBytes >= budget) break

    evict.push(c.projectId)
    plannedBytes += c.bytes
    used -= c.bytes
    cache -= c.bytes
  }

  return {
    triggered: evict.length > 0 || inp.force === true,
    trigger,
    evict,
    plannedBytes,
    evictableCount: eligible.length,
  }
}
