// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Where a host stops carrying VMs well — the CPU knee and the RAM knee.
 *
 * They are reported separately because they fail for different reasons and
 * have different fixes. The CPU knee is contention: turn steps slow down, PSI
 * `some` climbs, resumes miss the 2 s SLO. The RAM knee is exhaustion: OOM
 * kills, sustained swap-in, memory PSI `full`, MemAvailable gone. A host can
 * hit one long before the other, and the recommendation is the lower of the
 * two at prod VM sizing.
 *
 * Pure: every bound is an input, so a synthetic series with a known knee is a
 * unit test.
 */

export interface Bounds {
  /** Turn-step p95 may be at most this multiple of the N=1 baseline. */
  turnP95Ratio: number
  /** CPU PSI `some avg60` must stay under this percent. */
  cpuPsiSomeAvg60: number
  /** Resume p95 must stay under this many ms (the existing e2e-load SLO). */
  resumeP95Ms: number
  /** Sustained swap-in, pages/s averaged over the hold. */
  swapInPagesPerSec: number
  /** Memory PSI `full avg60` must stay under this percent. */
  memPsiFullAvg60: number
  /** MemAvailable must stay at or above this percent of MemTotal. */
  memAvailablePct: number
}

export const DEFAULT_BOUNDS: Bounds = {
  turnP95Ratio: 1.5,
  cpuPsiSomeAvg60: 25,
  resumeP95Ms: 2000,
  swapInPagesPerSec: 100,
  memPsiFullAvg60: 1,
  memAvailablePct: 10,
}

/** The turn steps whose p95 is compared against the N=1 baseline. */
export const TURN_STEPS = ['cpu', 'install', 'build'] as const
export type TurnStep = (typeof TURN_STEPS)[number]

export interface StepMetrics {
  n: number
  /** p95 wall-clock ms per turn step at this N. */
  turnP95: Record<TurnStep, number>
  cpuPsiSomeAvg60: number
  resumeP95Ms: number
  oomKills: number
  swapInPagesPerSec: number
  memPsiFullAvg60: number
  memAvailablePct: number
}

export interface StepVerdict {
  n: number
  cpuPass: boolean
  ramPass: boolean
  /** Human-readable reasons a bound was missed, e.g. `build p95 2.1x baseline`. */
  cpuReasons: string[]
  ramReasons: string[]
}

const round = (x: number, d = 2) => +x.toFixed(d)

/** Evaluate one step against the bounds, given the N=1 baseline turn latencies. */
export function evaluateStep(step: StepMetrics, baseline: Record<TurnStep, number>, bounds: Bounds = DEFAULT_BOUNDS): StepVerdict {
  const cpuReasons: string[] = []
  const ramReasons: string[] = []

  for (const s of TURN_STEPS) {
    const base = baseline[s]
    if (!(base > 0)) continue
    const ratio = step.turnP95[s] / base
    if (ratio > bounds.turnP95Ratio) cpuReasons.push(`${s} p95 ${round(ratio)}x baseline (limit ${bounds.turnP95Ratio}x)`)
  }
  if (step.cpuPsiSomeAvg60 >= bounds.cpuPsiSomeAvg60) {
    cpuReasons.push(`cpu PSI some avg60 ${round(step.cpuPsiSomeAvg60)}% (limit ${bounds.cpuPsiSomeAvg60}%)`)
  }
  if (step.resumeP95Ms >= bounds.resumeP95Ms) {
    cpuReasons.push(`resume p95 ${round(step.resumeP95Ms, 0)}ms (limit ${bounds.resumeP95Ms}ms)`)
  }

  if (step.oomKills > 0) ramReasons.push(`${step.oomKills} OOM kill(s)`)
  if (step.swapInPagesPerSec >= bounds.swapInPagesPerSec) {
    ramReasons.push(`swap-in ${round(step.swapInPagesPerSec, 1)} pages/s (limit ${bounds.swapInPagesPerSec})`)
  }
  if (step.memPsiFullAvg60 >= bounds.memPsiFullAvg60) {
    ramReasons.push(`memory PSI full avg60 ${round(step.memPsiFullAvg60)}% (limit ${bounds.memPsiFullAvg60}%)`)
  }
  if (step.memAvailablePct < bounds.memAvailablePct) {
    ramReasons.push(`MemAvailable ${round(step.memAvailablePct, 1)}% (floor ${bounds.memAvailablePct}%)`)
  }

  return { n: step.n, cpuPass: cpuReasons.length === 0, ramPass: ramReasons.length === 0, cpuReasons, ramReasons }
}

export interface Knees {
  /** Highest N that passed the CPU bounds, or 0 if even the first step failed. */
  cpuKnee: number
  /** Highest N that passed the RAM bounds, or 0. */
  ramKnee: number
  /** min(cpuKnee, ramKnee) — the number to recommend. */
  recommended: number
  verdicts: StepVerdict[]
}

/**
 * The knee is the highest N observed to meet the bounds.
 *
 * Deliberately *not* "the last unbroken pass from the smallest N". On the real
 * host the first step missed a turn-latency bound that the same bounds then
 * passed at 60 and 80 VMs — the first step's guests are cold (fresh image, cold
 * page cache) and its turn p95 mixes them with warm ones, so a low step can miss
 * a bound for a reason that has nothing to do with density. Under the prefix
 * rule that one sample became a knee of 0, twice, and the report recommended
 * running zero VMs on a host that was carrying 160.
 *
 * Each step is a held multi-minute measurement, so a higher step that passes is
 * evidence the host met the bounds at that density. A lower step's miss is
 * reported next to it (report.md lists every failing step and says when one sits
 * below the knee) rather than extrapolated over it.
 */
export function computeKnees(steps: StepMetrics[], baseline: Record<TurnStep, number>, bounds: Bounds = DEFAULT_BOUNDS): Knees {
  const ordered = [...steps].sort((a, b) => a.n - b.n)
  const verdicts = ordered.map((s) => evaluateStep(s, baseline, bounds))
  const highest = (pass: (v: StepVerdict) => boolean) => verdicts.filter(pass).reduce((max, v) => Math.max(max, v.n), 0)
  const cpuKnee = highest((v) => v.cpuPass)
  const ramKnee = highest((v) => v.ramPass)
  return { cpuKnee, ramKnee, recommended: Math.min(cpuKnee, ramKnee), verdicts }
}

/**
 * How many VMs of a given configured size fit in host RAM, from the measured
 * per-VM host RSS. `reservePct` is the headroom the host itself needs (kernel,
 * page cache, the agent) — the RAM knee's MemAvailable floor, expressed as a
 * share of MemTotal.
 */
export function ramCeilingForSize(input: { hostMemMiB: number; perVmRssMiB: number; reservePct: number }): number {
  const { hostMemMiB, perVmRssMiB, reservePct } = input
  if (!(hostMemMiB > 0) || !(perVmRssMiB > 0)) return 0
  const usable = hostMemMiB * (1 - Math.min(Math.max(reservePct, 0), 95) / 100)
  return Math.floor(usable / perVmRssMiB)
}

/** The recommendation table: the same measured RSS, at each prod VM size. */
export function ramCeilingsBySize(input: {
  hostMemMiB: number
  perVmRssMiB: number
  reservePct: number
  sizesMiB?: number[]
}): { sizeMiB: number; maxVms: number }[] {
  const sizes = input.sizesMiB ?? [2048, 4096]
  // Budget the *configured* size: a guest sized 4096 MiB may touch all of it, so
  // a host cannot be told it fits 218 of them because they happened to stay idle
  // during the soak. Measured RSS is only a floor.
  return sizes.map((sizeMiB) => ({
    sizeMiB,
    maxVms: ramCeilingForSize({ ...input, perVmRssMiB: Math.max(sizeMiB, input.perVmRssMiB) }),
  }))
}
