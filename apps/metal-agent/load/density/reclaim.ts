// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The idle-reclaim measurements SHO-534 shipped the code for and this card has
 * to make (SHO-553): what one idle VM still costs after reclaim, what a request
 * into a reclaimed VM pays to wake it, and what KSM actually buys.
 *
 * Two numbers are needed per run, and neither can be read off the host-wide
 * totals while tenants are resident:
 *
 * - **host RAM per idle VM** — the host's `(MemTotal − MemAvailable)` includes
 *   every real project on the box, so it is only meaningful on an empty host.
 *   When the host is not empty, the same figure is attributed to the soak as
 *   `(FC RSS now − FC RSS before the soak) / soak VMs`, and the per-VM
 *   `VmRSS − balloonedMiB` cross-check says how much of each guest is still
 *   real memory rather than a ballooned-away claim.
 * - **wake from reclaim** — a reclaimed VM answers only after its balloon is
 *   deflated (`pool.deflateReclaimed`, fired by `touch()`), so the cost of the
 *   feature is the first request into it.
 *
 * Everything here is pure so the numbers can be tested without a host.
 */

import { percentile, type HostSample } from './host-sampler'

/** Roles the harness assigns; only `idle` is ever reclaimed mid-run. */
export type SoakRole = 'agent' | 'app' | 'idle'

/** One soak VM as the host saw it at the moment a mark was taken. */
export interface IdleVmState {
  projectId: string
  role: SoakRole
  vmId?: string
  /** Guest RAM the balloon handed back to the host, MiB. 0 when reclaim is off. */
  balloonedMiB: number
  /** Firecracker `VmRSS`, MiB; null when the process could not be matched. */
  fcRssMiB: number | null
  /** When this VM was assigned, epoch ms. */
  assignedAtMs: number
}

/** One "what does an idle VM cost" mark, at 10 or 30 minutes into a hold. */
export interface IdleMemoryPoint {
  minutes: number
  /** Soak-attributable host RSS ÷ soak VMs, MiB. */
  soakDeltaPerVmMiB: number
  /** Mean `VmRSS − balloonedMiB` over idle VMs idle for the whole interval, MiB. */
  vmVmRssMinusBalloonMiB: number | null
  /** How many idle-role VMs met the whole-interval condition. */
  idleVms: number
  /** Soak VMs assigned at the mark. */
  soakVms: number
}

/** The runbook's resume budget: p95 may not exceed the baseline by more than this. */
export const WAKE_P95_BUDGET_MS = 100

/** How many idle VMs one run probes at the end of a hold. */
export const WAKE_PROBE_MIN = 10

export interface WakeSummary {
  /** VMs probed (a request that reached the guest, or timed out). */
  n: number
  p50Ms: number
  p95Ms: number
  /** Probes that never got a response. */
  errors: number
  /** p95 the budget was applied against, when a baseline run was given. */
  baselineP95Ms: number | null
  /** p95 − baseline, ms. Negative means the wake was free. */
  deltaP95Ms: number | null
  /** True when `deltaP95Ms` is inside `WAKE_P95_BUDGET_MS`. */
  pass: boolean | null
}

/** Counters from the last sample of a hold, plus the mean ksmd CPU over it. */
export interface KsmSummary {
  pagesSharing: number
  pagesShared: number
  fullScans: number
  ksmdCpuPct: number | null
  /** Peak sum of the soak's own `ksm_merging_pages`. */
  soakMergingPagesMax: number
  /** Samples the mean ksmd CPU was taken over. */
  samples: number
}

/** What one run records about reclaim. Everything except `steps` is run-level. */
export interface ReclaimSummary {
  /** Hold + 10 min, from the densest step that reached the mark. */
  at10: IdleMemoryPoint | null
  /** Hold + 30 min, likewise. */
  at30: IdleMemoryPoint | null
  /** Total ballooned MiB across idle soak VMs at the densest step. */
  balloonedIdleMiB: number | null
  /** Idle VMs whose balloon was actually inflated (FPR on and working). */
  balloonedIdleVms: number | null
  wake: WakeSummary | null
  ksm: KsmSummary | null
}

/** The bit of a step row these numbers are read from. */
export interface IdleStep {
  n: number
  idleAt10?: IdleMemoryPoint | null
  idleAt30?: IdleMemoryPoint | null
  balloonedIdleMiB?: number | null
  balloonedIdleVms?: number | null
}

const round = (x: number, d = 1) => (Number.isFinite(x) ? +x.toFixed(d) : 0)

/**
 * One "cost of an idle VM" mark.
 *
 * `soakRssMiB` and `rssBeforeMiB` are the host-side sum of every Firecracker
 * RSS before the soak and at the mark, so the difference is the soak's own
 * share of host RAM.
 *
 * Only idle-role VMs that have been assigned for at least the whole interval are
 * averaged: a VM that joined the soak 30 s ago has not spent 10 minutes idle, and
 * counting it would drag the mean down exactly when the mean matters most.
 */
export function idleMemoryPoint(input: {
  minutes: number
  nowMs: number
  rssBeforeMiB: number
  soakRssMiB: number
  soakVms: number
  vms: IdleVmState[]
}): IdleMemoryPoint {
  const { minutes, nowMs, rssBeforeMiB, soakRssMiB, soakVms, vms } = input
  const soakDeltaMiB = Math.max(0, soakRssMiB - rssBeforeMiB)
  const intervalMs = minutes * 60_000
  const settled = vms.filter((v) => v.role === 'idle' && v.fcRssMiB !== null && nowMs - v.assignedAtMs >= intervalMs)
  const perVm = settled.map((v) => Math.max(0, (v.fcRssMiB as number) - v.balloonedMiB))
  return {
    minutes,
    soakDeltaPerVmMiB: soakVms > 0 ? round(soakDeltaMiB / soakVms) : 0,
    vmVmRssMinusBalloonMiB: perVm.length > 0 ? round(perVm.reduce((a, b) => a + b, 0) / perVm.length) : null,
    idleVms: settled.length,
    soakVms,
  }
}

/** Idle VMs whose balloon is actually inflated — the only ones worth probing. */
export function balloonedVms(vms: IdleVmState[]): IdleVmState[] {
  return vms.filter((v) => v.role === 'idle' && v.balloonedMiB > 0)
}

/** What the idle VMs are holding as ballooned (i.e. already reused) RAM. */
export function balloonedIdleMiB(vms: IdleVmState[]): number {
  return balloonedVms(vms).reduce((a, v) => a + v.balloonedMiB, 0)
}

/**
 * Which idle VMs to wake-probe.
 *
 * Reclaimed ones first (largest balloon first — those are the ones that pay the
 * most to come back), then the rest of the idle role so run A, where nothing is
 * ever reclaimed, still measures the same count of VMs. Capped at `min`.
 */
export function pickWakeTargets(vms: IdleVmState[], min = WAKE_PROBE_MIN): IdleVmState[] {
  const idle = vms.filter((v) => v.role === 'idle').sort((a, b) => b.balloonedMiB - a.balloonedMiB)
  return idle.slice(0, Math.max(0, min))
}

/** p50/p95 of the wake probes, against an optional baseline run's p95. */
export function summarizeWake(latenciesMs: number[], errors = 0, baselineP95Ms?: number | null): WakeSummary {
  const ok = latenciesMs.filter((x) => Number.isFinite(x) && x >= 0)
  const p50Ms = round(percentile(ok, 50), 0)
  const p95Ms = round(percentile(ok, 95), 0)
  const base = baselineP95Ms ?? null
  const deltaP95Ms = base === null ? null : round(p95Ms - base, 0)
  return {
    n: ok.length + errors,
    p50Ms,
    p95Ms,
    errors,
    baselineP95Ms: base,
    deltaP95Ms,
    pass: deltaP95Ms === null ? null : deltaP95Ms <= WAKE_P95_BUDGET_MS,
  }
}

/**
 * KSM over a hold: the last counters (they are cumulative, so the last sample is
 * the run's total), the peak of the soak's own merging, and the mean ksmd CPU
 * across the samples that produced a rate.
 */
export function ksmSummary(samples: HostSample[]): KsmSummary | null {
  const withKsm = samples.filter((s) => s.ksm !== null)
  if (withKsm.length === 0) return null
  const last = withKsm[withKsm.length - 1].ksm!
  const rates = withKsm.map((s) => s.ksm!.ksmdCpuPct).filter((x): x is number => x !== null && Number.isFinite(x))
  return {
    pagesSharing: last.pagesSharing,
    pagesShared: last.pagesShared,
    fullScans: last.fullScans,
    ksmdCpuPct: rates.length > 0 ? round(rates.reduce((a, b) => a + b, 0) / rates.length, 2) : null,
    soakMergingPagesMax: Math.max(...withKsm.map((s) => s.ksm!.soakMergingPages)),
    samples: rates.length,
  }
}

/**
 * Roll a run's per-step marks into the run-level summary the A/B/C table reads.
 *
 * Each mark is taken from the densest step that reached it, not from the last
 * step: the point of the measurement is the host with the most VMs on it, and a
 * run that aborts after its densest step should still report what it measured.
 */
export function reclaimSummary(input: {
  steps: IdleStep[]
  wake?: WakeSummary | null
  samples?: HostSample[]
}): ReclaimSummary {
  const densest = [...input.steps].sort((a, b) => b.n - a.n)
  const at10 = densest.find((s) => s.idleAt10)?.idleAt10 ?? null
  const at30 = densest.find((s) => s.idleAt30)?.idleAt30 ?? null
  const balloon = densest.find((s) => s.balloonedIdleMiB !== undefined && s.balloonedIdleMiB !== null) ?? null
  return {
    at10,
    at30,
    balloonedIdleMiB: balloon?.balloonedIdleMiB ?? null,
    balloonedIdleVms: balloon?.balloonedIdleVms ?? null,
    wake: input.wake ?? null,
    ksm: input.samples ? ksmSummary(input.samples) : null,
  }
}

/**
 * Map `/vms` `assigned[]` plus the host's `/proc` into per-VM states.
 *
 * Kept here rather than in the runner so the join (projectId → vmId → pid →
 * RSS) is one testable function. A VM whose Firecracker process cannot be
 * found keeps `fcRssMiB: null` and is left out of the RSS mean rather than
 * counted as zero.
 */
export function idleVmStates(input: {
  assigned: { projectId: string; vmId?: string; balloonedMiB?: number; role?: SoakRole }[]
  assignedAt: Map<string, number>
  rssForVmId: (vmId: string) => number | null
}): IdleVmState[] {
  const out: IdleVmState[] = []
  for (const v of input.assigned) {
    const role = v.role ?? 'agent'
    out.push({
      projectId: v.projectId,
      role,
      vmId: v.vmId,
      balloonedMiB: Math.max(0, v.balloonedMiB ?? 0),
      fcRssMiB: v.vmId ? input.rssForVmId(v.vmId) : null,
      assignedAtMs: input.assignedAt.get(v.projectId) ?? 0,
    })
  }
  return out
}

/**
 * The staging tenants that shared the host with a run.
 *
 * A/B/C are only comparable if the host was carrying the same background as
 * each other, so every run records this at its start and its end. `assigned`
 * counts only non-soak VMs — our own soak VMs are not background load.
 */
export interface TenantSnapshot {
  at: string
  /** Non-soak VMs the agent had running. */
  assigned: number
  /** Of those, residency `active` (holding their RAM right now). */
  active: number
  /** Of those, residency `evictable` (could be suspended any time). */
  evictable: number
  /** VMs already suspended, so holding disk and state but no RAM. */
  suspended: number
  /** Our own soak VMs still assigned at the same moment, so they can be netted out. */
  soak: number
  memAvailableMiB: number | null
  swapUsedMiB: number | null
}

/** Snapshot the tenant population from a `GET /vms` payload plus `/proc/meminfo`. */
export function tenantSnapshot(input: {
  assigned: { projectId?: string; residency?: string }[]
  suspended?: { projectId?: string }[]
  mem: { availableMiB: number; swapTotalMiB: number; swapFreeMiB: number } | null
  at?: number
}): TenantSnapshot {
  let assigned = 0
  let active = 0
  let evictable = 0
  let soak = 0
  for (const v of input.assigned) {
    if ((v.projectId ?? '').startsWith('soak-')) {
      soak++
      continue
    }
    assigned++
    if (v.residency === 'active') active++
    else if (v.residency === 'evictable') evictable++
  }
  const suspended = (input.suspended ?? []).filter((v) => !(v.projectId ?? '').startsWith('soak-')).length
  return {
    at: new Date(input.at ?? Date.now()).toISOString(),
    assigned,
    active,
    evictable,
    suspended,
    soak,
    memAvailableMiB: input.mem ? Math.round(input.mem.availableMiB) : null,
    swapUsedMiB: input.mem ? Math.round(input.mem.swapTotalMiB - input.mem.swapFreeMiB) : null,
  }
}
