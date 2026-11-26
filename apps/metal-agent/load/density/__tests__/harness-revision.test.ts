// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { tmpdir } from 'os'
import { join } from 'path'
import { harnessDigest, harnessFiles } from '../harness-revision'
import { windowWorst } from '../host-sampler'
import type { HostSample } from '../host-sampler'

function harnessTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'))
  mkdirSync(join(dir, 'density'), { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

describe('harnessDigest', () => {
  // The soak host runs a deployed copy with no `.git`, so every committed run
  // used to record `gitSha: "unknown"` and could not say which tree measured it.
  test('covers the runner and the density modules, not tests or results', () => {
    const dir = harnessTree({
      'density-soak.ts': 'a',
      'density/report.ts': 'b',
      'density/__tests__/report.test.ts': 'c',
      'results/x.csv': 'd',
    })
    expect(harnessFiles(dir)).toEqual(['density-soak.ts', 'density/report.ts'])
  })

  test('is stable for the same files and changes when any of them does', () => {
    const one = harnessTree({ 'density-soak.ts': 'a', 'density/report.ts': 'b' })
    const same = harnessTree({ 'density-soak.ts': 'a', 'density/report.ts': 'b' })
    const changed = harnessTree({ 'density-soak.ts': 'a', 'density/report.ts': 'B' })
    expect(harnessDigest(one)).toBe(harnessDigest(same))
    expect(harnessDigest(one)).not.toBe(harnessDigest(changed))
  })

  test('a rename changes the digest even with identical content', () => {
    const a = harnessTree({ 'density-soak.ts': 'a', 'density/report.ts': 'x' })
    const b = harnessTree({ 'density-soak.ts': 'a', 'density/knee.ts': 'x' })
    expect(harnessDigest(a)).not.toBe(harnessDigest(b))
  })
})

describe('windowWorst', () => {
  // `memPressure.full60` is a 60 s rolling average, so the last sample of a burst
  // window still carries the hold that preceded it. The bound has to see the
  // window's worst sample, not whichever one happened to be last.
  const sample = (over: Partial<HostSample>): HostSample =>
    ({ ts: 0, mem: null, cpuPressure: null, memPressure: null, load: null, vmstat: null, fcProcs: 0, fcRssMiB: 0, runDelayMsPerSec: null, swapInPagesPerSec: null, memAvailablePct: null, ...over }) as HostSample

  test('takes the window max for pressure and the min for MemAvailable', () => {
    const win = [
      sample({ cpuPressure: { some10: 0, some60: 12, some300: 0, full10: 0, full60: 0, full300: 0 }, memPressure: { some10: 0, some60: 2.5, some300: 0, full10: 0, full60: 1.81, full300: 0 }, memAvailablePct: 42, swapInPagesPerSec: 1 }),
      sample({ cpuPressure: { some10: 0, some60: 4, some300: 0, full10: 0, full60: 0, full300: 0 }, memPressure: { some10: 0, some60: 1, some300: 0, full10: 0, full60: 1.02, full300: 0 }, memAvailablePct: 41.6, swapInPagesPerSec: 3 }),
    ]
    const worst = windowWorst(win)
    expect(worst.cpuPsiSomeAvg60).toBe(12)
    expect(worst.memPsiFullAvg60).toBe(1.81)
    expect(worst.memAvailablePct).toBe(41.6)
    expect(worst.swapInPagesPerSec).toBe(2)
  })

  test('an empty window is zero, not NaN', () => {
    expect(windowWorst([])).toEqual({ cpuPsiSomeAvg60: 0, memPsiFullAvg60: 0, memAvailablePct: 0, swapInPagesPerSec: 0 })
  })
})
