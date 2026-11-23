// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The N=1 baseline is the denominator every CPU verdict is measured against.
 *
 * Soak #5 on latitude-dal-1 reported `CPU knee 0 · recommend
 * METAL_MAX_VMS_PER_HOST=0` for a host that carried 160 VMs, because the
 * baseline was the p50 of the N=1 turns while each step was compared on p95: a
 * host with no contention failed on its own tail (N=40, CPU PSI 0.3%,
 * `install p95 2.68x baseline`). These tests pin the baseline to the statistic
 * the bounds actually use.
 */

import { describe, expect, test } from 'bun:test'
import { baselineFromTurns } from '../density-soak'
import { evaluateStep, type StepMetrics } from '../density/knee'
import type { TurnTimings } from '../density/guest-workload'

function turn(cpuMs: number, installMs: number, buildMs: number, ok = true): TurnTimings {
  return { cpuMs, installMs, buildMs, gitMs: 250, llmWaitMs: 0, ok, ...(ok ? {} : { error: 'boom' }) }
}

/** A quiet host's own distribution: a tight body and one slow sample. */
const TIGHT_BODY_WITH_TAIL = [
  turn(3020, 205, 1150),
  turn(3022, 210, 1155),
  turn(3024, 212, 1158),
  turn(3025, 215, 1160),
  turn(3026, 218, 1162),
  turn(3028, 220, 1165),
  turn(3030, 225, 1170),
  turn(3032, 240, 1180),
  turn(3035, 900, 3000),
]

function step(over: Partial<StepMetrics> = {}): StepMetrics {
  return {
    n: 40,
    turnP95: { cpu: 3025, install: 506, build: 1912 },
    cpuPsiSomeAvg60: 0.3,
    resumeP95Ms: 620,
    oomKills: 0,
    swapInPagesPerSec: 2.6,
    memPsiFullAvg60: 0,
    memAvailablePct: 59.5,
    ...over,
  }
}

describe('baselineFromTurns', () => {
  test('takes the p95, not the p50, of the N=1 turns', () => {
    const baseline = baselineFromTurns(TIGHT_BODY_WITH_TAIL)
    // The median of install is ~218 ms; the tail is 900 ms. Steps are compared
    // on p95, so the baseline has to sit at the tail, not the body.
    expect(baseline.install).toBeGreaterThan(400)
    expect(baseline.install).toBeLessThanOrEqual(900)
    expect(baseline.cpu).toBeGreaterThan(3026)
    expect(baseline.build).toBeGreaterThan(1170)
  })

  test('ignores failed turns, and gives 0 when nothing is usable', () => {
    const withFailure = baselineFromTurns([...TIGHT_BODY_WITH_TAIL, turn(0, 0, 0, false)])
    expect(withFailure.install).toBe(baselineFromTurns(TIGHT_BODY_WITH_TAIL).install)
    expect(baselineFromTurns([]).install).toBe(0)
  })
})

describe('a step measured against that baseline', () => {
  test('does not fail its own distribution', () => {
    const baseline = baselineFromTurns(TIGHT_BODY_WITH_TAIL)
    const verdict = evaluateStep(step({ turnP95: { cpu: baseline.cpu, install: baseline.install, build: baseline.build } }), baseline)
    expect(verdict.cpuPass).toBe(true)
    expect(verdict.cpuReasons).toEqual([])
  })

  test('still fails a real degradation, and names the line that broke', () => {
    // The N=100 step from soak #5.
    const baseline = baselineFromTurns(TIGHT_BODY_WITH_TAIL)
    const verdict = evaluateStep(step({ turnP95: { cpu: baseline.cpu, install: 1649, build: 4745 }, resumeP95Ms: 2211 }), baseline)
    expect(verdict.cpuPass).toBe(false)
    expect(verdict.cpuReasons.some((r) => r.includes('install p95'))).toBe(true)
    expect(verdict.cpuReasons.some((r) => r.includes('resume p95 2211ms'))).toBe(true)
  })
})
