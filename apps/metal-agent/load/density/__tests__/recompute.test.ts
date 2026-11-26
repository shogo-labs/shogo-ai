// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-deriving a recorded run's report from its CSVs.
 *
 * A soak costs hours of host time and the rules it feeds keep changing, so the
 * numbers a run already recorded must be able to answer the new rules. This
 * checks the round trip: what `writeReport` wrote, `recomputeReport` reads back
 * into the same steps and the same knee.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { evaluateStep, type StepMetrics, type TurnStep } from '../knee'
import { recomputeReport } from '../recompute'
import { writeReport, type ReportInput, type StepRow } from '../report'

const BASELINE: Record<TurnStep, number> = { cpu: 3034, install: 215, build: 1055 }

function turn(installMs: number, buildMs: number) {
  return { cpuMs: 3030, installMs, buildMs, gitMs: 250, llmWaitMs: 0, ok: true }
}

function step(n: number, occur: Partial<StepMetrics> = {}): StepRow {
  const metrics: StepMetrics = {
    n,
    turnP95: { cpu: 3030, install: 215, build: 1055 },
    cpuPsiSomeAvg60: 0.3,
    resumeP95Ms: 600,
    oomKills: 0,
    swapInPagesPerSec: 2.6,
    memPsiFullAvg60: 0,
    memAvailablePct: 50,
    ...occur,
  }
  return {
    ...metrics,
    cpuOversubRatio: +((n * 2) / 24).toFixed(2),
    ramCommittedMiB: n * 4096,
    ramPhysicalMiB: n * 2124,
    ramPhysicalBasis: 'soak-delta',
    turnP50: metrics.turnP95,
    runDelayP95MsPerSec: 0.5,
    apiP95Ms: 8,
    appP50Ms: 4.1,
    appP95Ms: 12.6,
    appSamples: 480,
    verdict: evaluateStep(metrics, BASELINE),
  }
}

const STEPS = [
  step(40, { turnP95: { cpu: 3025, install: 506, build: 1912 }, memAvailablePct: 59.5 }),
  step(60, { turnP95: { cpu: 3044, install: 251, build: 1190 }, memAvailablePct: 52.4 }),
  step(80, { turnP95: { cpu: 3041, install: 281, build: 1445 }, memAvailablePct: 40.5 }),
  step(100, { turnP95: { cpu: 3341, install: 1649, build: 4745 }, resumeP95Ms: 2211, memAvailablePct: 27.9 }),
]

function input(): ReportInput {
  return {
    env: {
      hostId: 'latitude-dal-1',
      hostModel: 'AMD EPYC 7443P 24-Core Processor',
      kernel: '6.8.0-124-generic',
      firecrackerVersion: 'Firecracker v1.16.1',
      gitSha: 'abc1234',
      harnessRevision: 'unknown',
      harnessSha256: 'unknown',
      region: 'us',
      controlPlaneUrl: 'https://api-staging.shogo.ai',
      vcpus: 2,
      memMiB: 4096,
      hostMemMiB: 515643,
      hostThreads: 24,
      maxVmsPerHost: 80,
      idleSuspendMs: 1800000,
      startedAt: '2026-11-23T11:06:00.000Z',
    },
    baseline: BASELINE,
    steps: STEPS,
    burst: [],
    knees: { cpuKnee: 0, ramKnee: 0, recommended: 0, verdicts: [] },
    recommendation: { maxVmsPerHost: 0, cpuKnee: 0, ramKnee: 0, bySize: [], perVmRssMiB: 0 },
    mix: { agent: 0.16, app: 0.01, idle: 0.83 },
  }
}

/** The baseline turns recorded as n=1 rows, plus one turn per step. */
const TURNS = [
  ...Array.from({ length: 20 }, (_, i) => ({ n: 1, role: 'agent', projectId: `soak-x-agent-${i}`, t: turn(205 + i, 1050 + i) })),
  { n: 40, role: 'agent', projectId: 'soak-x-agent-0000', t: turn(506, 1912) },
  { n: 80, role: 'agent', projectId: 'soak-x-agent-0001', t: turn(281, 1445) },
]

function record(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'density-recompute-')), 'density-test')
  writeReport(dir, input(), [], TURNS as any)
  return dir
}

describe('recomputeReport', () => {
  test('re-derives the knee from the recorded steps and baseline turns', () => {
    const dir = record()
    const { report } = recomputeReport(dir)
    // N=40 failed its turn bounds while 60 and 80 passed the same bounds.
    expect(report.knees.cpuKnee).toBe(80)
    expect(report.recommendation.maxVmsPerHost).toBe(80)
  })

  test('rebuilds the baseline from the n=1 turns at p95', () => {
    // 20 baseline turns at 205..224 ms; nearest-rank p95 is the 19th (223), not
    // the 215 the recorded report happened to carry.
    const dir = record()
    expect(recomputeReport(dir).report.baseline.install).toBe(223)
  })

  test('writes the report back to the run directory', () => {
    const dir = record()
    const { path } = recomputeReport(dir)
    const md = readFileSync(path, 'utf8')
    expect(md).toContain('METAL_MAX_VMS_PER_HOST=80')
    expect(md).toContain('**Below the knee:** N=40')
    expect(md).toContain('Re-derived from steps.csv')
  })

  test('a run without the basis column is read as host-wide, not as soak RAM', () => {
    // Run #2 predates the attribution: its steps.csv has no basis column and its
    // RAM column sums every Firecracker process on the host. Dividing that by N
    // produced 6473 MiB per VM against 4096 MiB guests.
    const dir = record()
    const csv = readFileSync(join(dir, 'steps.csv'), 'utf8')
    const legacy = csv
      .split('\n')
      .map((line, i) => {
        if (i === 0) return line.split(',').filter((_, c) => c !== 4).join(',')
        const cells = line.split(',')
        if (cells.length < 4) return line
        cells.splice(4, 1)
        return cells.join(',')
      })
      .join('\n')
    writeFileSync(join(dir, 'steps.csv'), legacy)

    const { report, path } = recomputeReport(dir)
    expect(report.steps[0].ramPhysicalBasis).toBe('host-wide')
    expect(report.recommendation.perVmRssMiB).toBe(0)
    expect(report.recommendation.bySize).toEqual([])
    const md = readFileSync(path, 'utf8')
    expect(md).toContain('Not measured in this run')
  })

  test('does not clobber a recorded burst it cannot reproduce', () => {
    const dir = record()
    const withBurst = readFileSync(join(dir, 'report.md'), 'utf8') + '\n## Burst\n\n| N | pass |\n|---|---|\n| 80 | FAIL |\n'
    writeFileSync(join(dir, 'report.md'), withBurst)
    writeFileSync(join(dir, 'burst.csv'), '')

    const { path } = recomputeReport(dir)
    expect(path).toEndWith('report.recomputed.md')
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('## Burst')
    expect(readFileSync(path, 'utf8')).not.toContain('see the original report')
  })

  test('refuses a run recorded before the baseline turns existed', () => {
    const dir = record()
    writeFileSync(join(dir, 'turns.csv'), 'n,role,project_id,cpu_ms,install_ms,build_ms,git_ms,llm_wait_ms,ok,error\n')
    expect(() => recomputeReport(dir)).toThrow(/no N=1 rows/)
  })
})
