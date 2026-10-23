// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The hard limit on how many background runtimes a desktop will keep: free
 * host memory.
 *
 * Raising the background pool cap (SHO-143: 2 → 10) is only safe if something
 * still stops a machine from drowning. The pool cap is a *policy* number — it
 * says how many agents may stay warm, not how many the RAM can carry. This
 * module answers the second question so the pool can queue a start instead of
 * killing a runtime that is busy working.
 */
import { freemem, totalmem } from 'os'

/** Below this much free memory, a new background runtime waits its turn. */
const MIN_FLOOR_MB = 1024
/** …and above this, the floor stops growing with the machine. */
const MAX_FLOOR_MB = 1536
const FLOOR_FRACTION = 0.1

export interface HostMemorySample {
  totalMb: number
  freeMb: number
  /** Free memory must stay at or above this for a background start to proceed. */
  floorMb: number
  low: boolean
}

/**
 * The free-memory floor for admitting a background runtime.
 *
 * 10% of the machine, clamped to 1–1.5 GB: enough headroom for one more
 * runtime's steady state plus the OS, without making a small laptop queue
 * every heartbeat for a memory it will never have free.
 *
 * `WORKSPACE_BACKGROUND_MIN_FREE_MB` overrides it; `0` disables the guard.
 */
export function resolveBackgroundMemoryFloorMb(
  totalMb: number,
  override?: string | null,
): number {
  const raw = override ?? process.env.WORKSPACE_BACKGROUND_MIN_FREE_MB
  if (raw != null && raw !== '') {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  if (!Number.isFinite(totalMb) || totalMb <= 0) return MIN_FLOOR_MB
  const scaled = Math.floor(totalMb * FLOOR_FRACTION)
  return Math.min(MAX_FLOOR_MB, Math.max(MIN_FLOOR_MB, scaled))
}

export function toMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

/**
 * Read the host's memory now. Injectable numbers keep the decision testable
 * without allocating (or freeing) gigabytes.
 */
export function sampleHostMemory(override?: {
  totalMb?: number
  freeMb?: number
  floorMb?: number
}): HostMemorySample {
  const totalMb = override?.totalMb ?? toMb(totalmem())
  const freeMb = override?.freeMb ?? toMb(freemem())
  const floorMb = override?.floorMb ?? resolveBackgroundMemoryFloorMb(totalMb)
  return { totalMb, freeMb, floorMb, low: floorMb > 0 && freeMb < floorMb }
}
