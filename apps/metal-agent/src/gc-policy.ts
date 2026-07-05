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
  /** 0 = disabled. */
  cacheMaxBytes: number
  /** Force eviction of everything evictable regardless of watermarks. */
  force?: boolean
}

export interface GcDecision {
  /** True if the sweep should evict (pressure crossed, cap exceeded, or forced). */
  triggered: boolean
  /** projectIds to evict, in eviction order (LRU first). */
  evict: string[]
  /** Bytes expected to be reclaimed. */
  plannedBytes: number
}

/** projects eligible for eviction, oldest-access first. */
function evictable(candidates: EvictionCandidate[]): EvictionCandidate[] {
  return candidates
    .filter((c) => c.durableBacked && !c.inFlight)
    .sort((a, b) => a.lastAccessAt - b.lastAccessAt)
}

/**
 * Decide the eviction set. We evict when disk crosses the high watermark (bring
 * used% back to low), OR when the cache byte cap is exceeded, OR when forced.
 * Eviction stops as soon as BOTH constraints are satisfied.
 */
export function planEvictions(inp: GcInputs): GcDecision {
  const usedPct = inp.totalBytes > 0 ? (inp.usedBytes / inp.totalBytes) * 100 : 0
  const overWatermark = usedPct >= inp.highPct
  const overCap = inp.cacheMaxBytes > 0 && inp.cacheBytes > inp.cacheMaxBytes

  if (!inp.force && !overWatermark && !overCap) {
    return { triggered: false, evict: [], plannedBytes: 0 }
  }

  const lowBytes = (inp.lowPct / 100) * inp.totalBytes
  let used = inp.usedBytes
  let cache = inp.cacheBytes
  const evict: string[] = []
  let plannedBytes = 0

  for (const c of evictable(inp.candidates)) {
    const diskSatisfied = !inp.force && (inp.totalBytes === 0 || used <= lowBytes)
    const capSatisfied = inp.cacheMaxBytes <= 0 || cache <= inp.cacheMaxBytes
    // When forced, drain everything evictable; otherwise stop once both are met.
    if (!inp.force && diskSatisfied && capSatisfied) break

    evict.push(c.projectId)
    plannedBytes += c.bytes
    used -= c.bytes
    cache -= c.bytes
  }

  return { triggered: evict.length > 0 || inp.force === true, evict, plannedBytes }
}
