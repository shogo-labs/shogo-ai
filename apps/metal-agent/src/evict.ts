// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The "ready to suspend" bucket: deciding when a host is full, and which warm
 * VM to suspend to make room (SHO-444).
 *
 * An idle VM is `evictable` (see `MetalWarmPool.vmResidency`): it stays
 * resident, so the user's next click is an instant resume, but it counts as
 * free capacity. It is suspended early only when an assign or resume on this
 * host actually needs the slot or the RAM — never on a region-wide timer.
 *
 * Everything here is pure so the policy can be tested without a host: the pool
 * supplies the counts and does the suspending.
 */

/** One assigned VM that may be evicted, with how long it has been idle. */
export interface EvictCandidate {
  projectId: string
  /** `now − (lastRealActivityAt ?? assignedAt)` — the same clock the reaper uses. */
  idleMs: number
}

export interface FullnessInput {
  /** VMs resident on the host right now (`assigned.size`). */
  resident: number
  /** `METAL_MAX_RESIDENT_VMS_PER_HOST`; 0 = no count cap. */
  residentCap: number
  /** Host MemAvailable in MiB, or undefined off Linux (no /proc/meminfo). */
  memAvailableMiB?: number
  /** RAM the incoming VM will occupy. */
  vmMemMiB: number
  /** `METAL_EVICT_MEM_RESERVE_MIB` (already resolved from the 10% default). */
  memReserveMiB: number
}

export type FullnessReason = 'slots' | 'mem'

/**
 * Would admitting one more VM leave this host without room?
 *
 * Two independent triggers, because a host runs out of two different things:
 *   - `slots` — a configured resident-VM cap (off by default; see config.ts).
 *   - `mem`   — MemAvailable after the incoming VM would drop below the
 *               reserve. Off when the host has no meminfo (not Linux) or the
 *               reserve is 0.
 *
 * Taps are deliberately not a trigger: tap exhaustion is a separate failure
 * with its own GC, and evicting a VM does not reliably return a tap.
 */
export function hostFullness(i: FullnessInput): { full: boolean; reason?: FullnessReason } {
  if (i.residentCap > 0 && i.resident + 1 > i.residentCap) return { full: true, reason: 'slots' }
  if (i.memReserveMiB > 0 && typeof i.memAvailableMiB === 'number') {
    if (i.memAvailableMiB - i.vmMemMiB < i.memReserveMiB) return { full: true, reason: 'mem' }
  }
  return { full: false }
}

/**
 * The reserve to keep free, from the configured value or 10% of MemTotal.
 *
 * A percentage rather than a constant because the hosts differ by an order of
 * magnitude (a 256 GiB box and a 32 GiB box need very different absolute
 * headroom), and because the reserve exists to absorb the kernel's own
 * behaviour — page cache, the next VM's boot — which scales with the machine.
 */
export function resolveMemReserveMiB(configuredMiB: number, totalMiB: number | undefined): number {
  if (configuredMiB > 0) return configuredMiB
  if (!(totalMiB && totalMiB > 0)) return 0
  return Math.round(totalMiB * 0.1)
}

export interface SelectInput {
  candidates: EvictCandidate[]
  /** Never evict these: the project being assigned, and anything already going. */
  exclude: ReadonlySet<string>
  /** VMs a concurrent assign/resume has already picked (see `MetalWarmPool.evicting`). */
  evicting: ReadonlySet<string>
}

/**
 * The longest-idle evictable VM, or undefined when there is nothing to give up.
 *
 * Longest-idle first is the same order the reaper suspends in, so an eviction
 * takes the VM that was closest to being suspended anyway — the one whose user
 * is least likely to come back this second.
 */
export function selectEvictionVictim(i: SelectInput): EvictCandidate | undefined {
  let best: EvictCandidate | undefined
  for (const c of i.candidates) {
    if (i.exclude.has(c.projectId) || i.evicting.has(c.projectId)) continue
    if (!best || c.idleMs > best.idleMs) best = c
  }
  return best
}
