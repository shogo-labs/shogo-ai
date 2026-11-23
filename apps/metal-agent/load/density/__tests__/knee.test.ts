// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BOUNDS,
  computeKnees,
  evaluateStep,
  ramCeilingForSize,
  ramCeilingsBySize,
  type StepMetrics,
  type TurnStep,
} from '../knee'

const baseline: Record<TurnStep, number> = { cpu: 3000, install: 2000, build: 3000 }

/** A step that passes every bound at N. */
function healthy(n: number, over: Partial<StepMetrics> = {}): StepMetrics {
  return {
    n,
    turnP95: { cpu: 3000, install: 2000, build: 3000 },
    cpuPsiSomeAvg60: 5,
    resumeP95Ms: 400,
    oomKills: 0,
    swapInPagesPerSec: 0,
    memPsiFullAvg60: 0,
    memAvailablePct: 60,
    ...over,
  }
}

describe('evaluateStep', () => {
  test('a healthy step passes both knees', () => {
    const v = evaluateStep(healthy(40), baseline)
    expect(v.cpuPass).toBe(true)
    expect(v.ramPass).toBe(true)
    expect(v.cpuReasons).toEqual([])
    expect(v.ramReasons).toEqual([])
  })

  test('turn p95 over 1.5x baseline fails the CPU knee', () => {
    const v = evaluateStep(healthy(80, { turnP95: { cpu: 3000, install: 2000, build: 4501 } }), baseline)
    expect(v.cpuPass).toBe(false)
    expect(v.cpuReasons.join(' ')).toContain('build p95 1.5x baseline')
  })

  test('exactly 1.5x still passes (the bound is inclusive)', () => {
    const v = evaluateStep(healthy(80, { turnP95: { cpu: 4500, install: 2000, build: 3000 } }), baseline)
    expect(v.cpuPass).toBe(true)
  })

  test('CPU PSI some avg60 at the limit fails', () => {
    const v = evaluateStep(healthy(80, { cpuPsiSomeAvg60: DEFAULT_BOUNDS.cpuPsiSomeAvg60 }), baseline)
    expect(v.cpuPass).toBe(false)
    expect(v.cpuReasons.join(' ')).toContain('cpu PSI some avg60')
  })

  test('resume p95 at the 2s SLO fails', () => {
    const v = evaluateStep(healthy(80, { resumeP95Ms: 2000 }), baseline)
    expect(v.cpuPass).toBe(false)
    expect(v.cpuReasons.join(' ')).toContain('resume p95 2000ms')
  })

  test('one OOM kill fails the RAM knee', () => {
    const v = evaluateStep(healthy(80, { oomKills: 1 }), baseline)
    expect(v.ramPass).toBe(false)
    expect(v.ramReasons.join(' ')).toContain('1 OOM kill')
  })

  test('sustained swap-in fails the RAM knee', () => {
    const v = evaluateStep(healthy(80, { swapInPagesPerSec: 100 }), baseline)
    expect(v.ramPass).toBe(false)
    expect(v.ramReasons.join(' ')).toContain('swap-in 100 pages/s')
  })

  test('memory PSI full at the limit fails the RAM knee', () => {
    const v = evaluateStep(healthy(80, { memPsiFullAvg60: 1 }), baseline)
    expect(v.ramPass).toBe(false)
    expect(v.ramReasons.join(' ')).toContain('memory PSI full avg60')
  })

  test('MemAvailable below the floor fails the RAM knee', () => {
    const v = evaluateStep(healthy(80, { memAvailablePct: 9.9 }), baseline)
    expect(v.ramPass).toBe(false)
    expect(v.ramReasons.join(' ')).toContain('MemAvailable 9.9%')
  })

  test('a CPU failure does not fail the RAM knee, and vice versa', () => {
    const cpuOnly = evaluateStep(healthy(80, { cpuPsiSomeAvg60: 40 }), baseline)
    expect(cpuOnly.cpuPass).toBe(false)
    expect(cpuOnly.ramPass).toBe(true)
    const ramOnly = evaluateStep(healthy(80, { oomKills: 2 }), baseline)
    expect(ramOnly.cpuPass).toBe(true)
    expect(ramOnly.ramPass).toBe(false)
  })
})

describe('computeKnees', () => {
  test('a synthetic series with a known CPU knee', () => {
    // CPU degrades at 100; RAM is fine throughout.
    const steps = [
      healthy(40),
      healthy(60),
      healthy(80),
      healthy(100, { turnP95: { cpu: 3000, install: 2000, build: 6000 } }),
      healthy(120, { turnP95: { cpu: 3000, install: 2000, build: 9000 } }),
    ]
    const k = computeKnees(steps, baseline)
    expect(k.cpuKnee).toBe(80)
    expect(k.ramKnee).toBe(120)
    expect(k.recommended).toBe(80)
  })

  test('a synthetic series with a known RAM knee', () => {
    const steps = [healthy(40), healthy(60), healthy(80, { oomKills: 1 }), healthy(100, { oomKills: 3 })]
    const k = computeKnees(steps, baseline)
    expect(k.cpuKnee).toBe(100)
    expect(k.ramKnee).toBe(60)
    expect(k.recommended).toBe(60)
  })

  test('a failing step does not cap a knee that a higher step reaches', () => {
    // The real shape, against the baseline this run actually measured: the first
    // step's guests are cold and miss a turn bound, then the same bounds pass at
    // 60 and 80 VMs and break at 100.
    const measured: Record<TurnStep, number> = { cpu: 3034, install: 209, build: 1052 }
    const steps = [
      healthy(40, { turnP95: { cpu: 3025, install: 506, build: 1912 } }),
      healthy(60, { turnP95: { cpu: 3044, install: 251, build: 1190 } }),
      healthy(80, { turnP95: { cpu: 3041, install: 281, build: 1445 } }),
      healthy(100, { turnP95: { cpu: 3341, install: 1649, build: 4745 }, resumeP95Ms: 2211 }),
    ]
    const k = computeKnees(steps, measured)
    expect(k.verdicts.find((v) => v.n === 40)!.cpuPass).toBe(false)
    expect(k.cpuKnee).toBe(80)
  })

  test('a step that fails and has nothing passing above it is still the knee boundary', () => {
    // 80 is the highest pass; 100 and 120 break, so 80 is the answer.
    const steps = [healthy(80), healthy(100, { cpuPsiSomeAvg60: 30 }), healthy(120, { cpuPsiSomeAvg60: 40 })]
    expect(computeKnees(steps, baseline).cpuKnee).toBe(80)
  })

  test('sorts steps by N before walking', () => {
    const steps = [healthy(80), healthy(40), healthy(60)]
    expect(computeKnees(steps, baseline).cpuKnee).toBe(80)
  })

  test('a series where nothing passes gives 0', () => {
    const k = computeKnees([healthy(40, { oomKills: 1 })], baseline)
    expect(k.ramKnee).toBe(0)
    expect(k.recommended).toBe(0)
  })

  test('no steps gives 0', () => {
    expect(computeKnees([], baseline)).toMatchObject({ cpuKnee: 0, ramKnee: 0, recommended: 0 })
  })

  test('verdicts are returned in N order', () => {
    const k = computeKnees([healthy(80), healthy(40)], baseline)
    expect(k.verdicts.map((v) => v.n)).toEqual([40, 80])
  })
})

describe('ramCeilingForSize', () => {
  test('reserves the headroom share', () => {
    // 256 GiB host, 2 GiB per VM, 10% reserved → 115 VMs.
    expect(ramCeilingForSize({ hostMemMiB: 262144, perVmRssMiB: 2048, reservePct: 10 })).toBe(115)
  })

  test('a bigger VM fits fewer', () => {
    const small = ramCeilingForSize({ hostMemMiB: 262144, perVmRssMiB: 2048, reservePct: 10 })
    const big = ramCeilingForSize({ hostMemMiB: 262144, perVmRssMiB: 4096, reservePct: 10 })
    expect(big).toBeLessThan(small)
  })

  test('zero or negative inputs give 0', () => {
    expect(ramCeilingForSize({ hostMemMiB: 0, perVmRssMiB: 2048, reservePct: 10 })).toBe(0)
    expect(ramCeilingForSize({ hostMemMiB: 262144, perVmRssMiB: 0, reservePct: 10 })).toBe(0)
  })

  test('clamps an absurd reserve', () => {
    // 200% is clamped to 95%, so only 5% of the host is usable: 50 MiB / 100 MiB.
    expect(ramCeilingForSize({ hostMemMiB: 1000, perVmRssMiB: 100, reservePct: 200 })).toBe(0)
    expect(ramCeilingForSize({ hostMemMiB: 1000, perVmRssMiB: 10, reservePct: 200 })).toBe(5)
  })

  test('bySize covers 2 GiB and 4 GiB', () => {
    const rows = ramCeilingsBySize({ hostMemMiB: 262144, perVmRssMiB: 2048, reservePct: 10 })
    expect(rows.map((r) => r.sizeMiB)).toEqual([2048, 4096])
  })

  test('bySize budgets the configured size, not the observed RSS', () => {
    // Soak #5 printed 218 for both rows because the measured RSS (2124 MiB)
    // replaced the size in the calculation, making a 4096 MiB guest look as
    // cheap as a 2048. A guest may touch all of its configured size.
    const input = { hostMemMiB: 515643, perVmRssMiB: 2124, reservePct: 10 }
    const rows = ramCeilingsBySize(input)
    const by2048 = rows.find((r) => r.sizeMiB === 2048)!.maxVms
    const by4096 = rows.find((r) => r.sizeMiB === 4096)!.maxVms
    expect(by2048).toBe(ramCeilingForSize(input))
    expect(by4096).toBe(ramCeilingForSize({ ...input, perVmRssMiB: 4096 }))
    expect(by4096).toBeLessThan(by2048)
  })
})
