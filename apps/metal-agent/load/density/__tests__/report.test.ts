// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeKnees, type StepMetrics, type TurnStep } from '../knee'
import { abcMarkdown, parseAbcRuns, perVmRssMiB, readReportInput, renderReportMarkdown, samplesCsv, stepsCsv, turnsCsv, writeAbc, writeReport, type AbcRun, type ReportInput, type StepRow } from '../report'
import type { ReclaimSummary } from '../reclaim'
import type { HostSample } from '../host-sampler'

const baseline: Record<TurnStep, number> = { cpu: 3000, install: 2000, build: 3000 }

function step(n: number, over: Partial<StepMetrics> = {}): StepRow {
  const metrics: StepMetrics = {
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
  const verdict = computeKnees([metrics], baseline).verdicts[0]
  return {
    ...metrics,
    cpuOversubRatio: (n * 2) / 48,
    ramCommittedMiB: n * 2048,
    ramPhysicalMiB: n * 1024,
    ramPhysicalBasis: 'soak-delta',
    turnP50: { cpu: 2900, install: 1900, build: 2900 },
    runDelayP95MsPerSec: 1.5,
    apiP95Ms: 12,
    verdict,
  }
}

function input(rows: StepRow[]): ReportInput {
  const knees = computeKnees(rows, baseline)
  return {
    env: {
      hostId: 'latitude-dal-1',
      hostModel: 'AMD EPYC 7443',
      kernel: '6.1.102',
      firecrackerVersion: 'Firecracker v1.7.0',
      gitSha: 'abc1234',
      region: 'us',
      controlPlaneUrl: 'https://api-staging.shogo.ai',
      vcpus: 2,
      memMiB: 2048,
      hostMemMiB: 262144,
      hostThreads: 48,
      maxVmsPerHost: 80,
      idleSuspendMs: 0,
      startedAt: '2026-11-19T00:00:00.000Z',
      finishedAt: '2026-11-19T02:00:00.000Z',
    },
    baseline,
    steps: rows,
    burst: [],
    knees,
    recommendation: {
      maxVmsPerHost: knees.recommended,
      cpuKnee: knees.cpuKnee,
      ramKnee: knees.ramKnee,
      bySize: [
        { sizeMiB: 2048, maxVms: 115 },
        { sizeMiB: 4096, maxVms: 57 },
      ],
      perVmRssMiB: 1024,
    },
    mix: { agent: 0.16, app: 0.01, idle: 0.83 },
  }
}

describe('stepsCsv', () => {
  test('has a header and one row per step', () => {
    const csv = stepsCsv([step(40), step(80)])
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('n,cpu_oversub_ratio')
    expect(lines[0]).toContain('build_p95_ms')
    expect(lines[1].startsWith('40,')).toBe(true)
    expect(lines[2].startsWith('80,')).toBe(true)
  })

  test('carries the pass/fail verdict', () => {
    const csv = stepsCsv([step(80, { oomKills: 1 })])
    const lines = csv.trim().split('\n')
    const header = lines[0].split(',')
    const row = lines[1].split(',')
    expect(row[header.indexOf('cpu_pass')]).toBe('true')
    expect(row[header.indexOf('ram_pass')]).toBe('false')
  })
})

describe('samplesCsv', () => {
  test('renders a sample row', () => {
    const s: HostSample = {
      ts: 1000,
      mem: { totalMiB: 262144, availableMiB: 131072, swapTotalMiB: 8192, swapFreeMiB: 8192 },
      cpuPressure: { some10: 1, some60: 2, some300: 3, full10: 0, full60: 0, full300: 0 },
      memPressure: { some10: 0, some60: 0, some300: 0, full10: 0, full60: 0, full300: 0 },
      load: { load1: 12, load5: 10, load15: 8, procsRunning: 40, procsTotal: 900 },
      vmstat: { pswpin: 0, pswpout: 0 },
      fcProcs: 80,
      fcRssMiB: 81920,
      runDelayMsPerSec: { p50: 1, p95: 4, max: 9, threads: 160 },
      swapInPagesPerSec: 0,
      memAvailablePct: 50,
      ksm: null,
    }
    const csv = samplesCsv([s])
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('262144')
    expect(lines[1]).toContain('81920')
  })
})

describe('turnsCsv', () => {
  test('renders a turn row', () => {
    const csv = turnsCsv([{ n: 40, role: 'agent', projectId: 'soak-x-agent-0000', t: { cpuMs: 3100, installMs: 2100, buildMs: 3200, gitMs: 900, llmWaitMs: 0, ok: true } }])
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('n,role,project_id,cpu_ms,install_ms,build_ms,git_ms,llm_wait_ms,ok,error')
    expect(lines[1]).toBe('40,agent,soak-x-agent-0000,3100,2100,3200,900,0,true,')
  })
})

describe('renderReportMarkdown', () => {
  test('states the recommendation and both knees', () => {
    const md = renderReportMarkdown(input([step(40), step(80), step(120, { oomKills: 1 })]))
    expect(md).toContain('METAL_MAX_VMS_PER_HOST=80')
    // CPU is fine all the way to 120; RAM fails at 120 (one OOM kill).
    expect(md).toContain('CPU knee **120**')
    expect(md).toContain('RAM knee **80**')
    expect(md).toContain('| 40 |')
    expect(md).toContain('| 120 |')
  })

  test('explains why a step failed', () => {
    const md = renderReportMarkdown(input([step(40), step(80, { oomKills: 2 })]))
    expect(md).toContain('Why each step failed')
    expect(md).toContain('**N=80**: 2 OOM kill(s)')
  })

  test('shows the abort reason when the run stopped early', () => {
    const i = input([step(40)])
    i.env.abortReason = 'MemAvailable fell to 4.2% (abort floor 5%)'
    expect(renderReportMarkdown(i)).toContain('Run aborted early')
  })

  test('renders burst rows', () => {
    const i = input([step(40)])
    i.burst = [
      {
        n: 40,
        fraction: 0.25,
        windowMs: 60_000,
        turnsStarted: 10,
        turnP95: { cpu: 4000, install: 2500, build: 4200 },
        cpuPsiSomeAvg60: 30,
        memAvailablePct: 40,
        oomKills: 0,
        resumeP95Ms: 900,
        pass: false,
      },
    ]
    const md = renderReportMarkdown(i)
    expect(md).toContain('## Burst')
    expect(md).toContain('| 40 | 25% | 60s | 10 |')
  })

  test('renders the per-size RAM table', () => {
    const md = renderReportMarkdown(input([step(40)]))
    expect(md).toContain('| 2048 MiB | 115 |')
    expect(md).toContain('| 4096 MiB | 57 |')
  })

  test('a zero knee is a failed measurement, not a capacity of zero', () => {
    // Soak #5 recommended `METAL_MAX_VMS_PER_HOST=0` for a host that carried
    // 160 VMs; a knee of 0 means nothing measured passed, never "run nothing".
    const i = input([step(40)])
    i.recommendation = { ...i.recommendation, maxVmsPerHost: 0, cpuKnee: 0, ramKnee: 0 }
    const md = renderReportMarkdown(i)
    expect(md).not.toContain('METAL_MAX_VMS_PER_HOST=0')
    expect(md).toContain('No recommendation')
    expect(md).toContain('not a capacity of zero')
  })

  test('labels the baseline table with the statistic the bounds compare', () => {
    expect(renderReportMarkdown(input([step(40)]))).toContain('| step | p95 ms |')
  })

  test('a host-wide RSS column is never presented as the soak\'s RAM', () => {
    // Run #2 recorded every Firecracker process on the host, so 6473 MiB per
    // soak VM appeared against 4096 MiB guests. The table must say what it is.
    const rows = [{ ...step(40), ramPhysicalBasis: 'host-wide' as const, ramPhysicalMiB: 258941 }]
    const i = input(rows)
    i.recommendation = { ...i.recommendation, perVmRssMiB: 0, bySize: [] }
    const md = renderReportMarkdown(i)
    expect(md).toContain('RAM physical (host FC, not soak)')
    expect(md).not.toContain('RAM physical (soak)')
    expect(md).toContain('Not measured in this run')
  })

  test('per-VM RSS comes from attributed steps only, at the densest one', () => {
    const rows = [
      { ...step(40), ramPhysicalBasis: 'host-wide' as const, ramPhysicalMiB: 258941 },
      { ...step(80), ramPhysicalBasis: 'soak-delta' as const, ramPhysicalMiB: 80 * 2100 },
      { ...step(100), ramPhysicalBasis: 'soak-delta' as const, ramPhysicalMiB: 100 * 2000 },
    ]
    expect(perVmRssMiB(rows)).toBe(2000)
    expect(perVmRssMiB([rows[0]])).toBe(0)
  })
})

describe('writeReport', () => {
  test('writes every file', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'density-report-')), 'density-test')
    const written = writeReport(dir, input([step(40)]), [], [])
    expect(written.files.sort()).toEqual(['burst.csv', 'env.json', 'report.json', 'report.md', 'samples.csv', 'steps.csv', 'turns.csv'])
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('Metal density soak')
    expect(JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')).hostId).toBe('latitude-dal-1')
  })
})

function withReclaim(over: Partial<ReclaimSummary> = {}): ReportInput {
  return {
    ...input([step(40)]),
    reclaim: {
      at10: { minutes: 10, soakDeltaPerVmMiB: 300.4, vmVmRssMinusBalloonMiB: 250.2, idleVms: 32, soakVms: 40 },
      at30: { minutes: 30, soakDeltaPerVmMiB: 410.7, vmVmRssMinusBalloonMiB: 200.9, idleVms: 30, soakVms: 40 },
      balloonedIdleMiB: 6144,
      balloonedIdleVms: 32,
      wake: { n: 12, p50Ms: 180, p95Ms: 240, errors: 0, baselineP95Ms: 200, deltaP95Ms: 40, pass: true },
      ksm: { pagesSharing: 12345, pagesShared: 6789, fullScans: 42, ksmdCpuPct: 3.5, soakMergingPagesMax: 900, samples: 12 },
      ...over,
    },
  }
}

describe('abcMarkdown', () => {
  test('puts one column per run in the order given', () => {
    const md = abcMarkdown([{ label: 'A (baseline)', input: input([step(40)]) }, { label: 'B (reclaim + FPR)', input: withReclaim() }])
    expect(md).toContain('| | A (baseline) | B (reclaim + FPR) |')
    expect(md).toContain('host RAM per idle VM @10 min (MiB)')
  })

  test('reads every reclaim number from the run that measured it', () => {
    const md = abcMarkdown([{ label: 'A', input: input([step(40)]) }, { label: 'B', input: withReclaim() }])
    expect(md).toContain('| host RAM per idle VM @10 min (MiB) | — | 300.4 |')
    expect(md).toContain('| VmRSS − ballooned @30 min (MiB) | — | 200.9 |')
    expect(md).toContain('| ballooned by idle VMs (MiB) | — | 6144 |')
    expect(md).toContain('| ksmd CPU (% of one core) | n/a | 3.50 |')
    expect(md).toContain('| KSM pages_sharing | n/a | 12345 |')
    expect(md).toContain('| wake from reclaim p50 / p95 (ms) | — | 180 / 240 |')
    expect(md).toContain('| wake p95 vs A (ms, budget ≤ +100) | — | +40 |')
  })

  test('a cell a run did not measure stays a dash, never borrowed from another run', () => {
    const md = abcMarkdown([{ label: 'A', input: input([step(40)]) }, { label: 'B', input: withReclaim({ wake: null, ksm: null }) }])
    // B's wake/ksm are null: its row must be empty even though column A is too.
    expect(md).toContain('| wake from reclaim p50 / p95 (ms) | — | — |')
    expect(md).toContain('| ksmd CPU (% of one core) | n/a | n/a |')
  })

  test('records an aborted run and its reason', () => {
    const aborted = { ...withReclaim(), env: { ...withReclaim().env, abortReason: 'MemAvailable < 5%' } }
    const md = abcMarkdown([{ label: 'A', input: input([step(40)]) }, { label: 'C', input: aborted }])
    expect(md).toContain('(**aborted:** MemAvailable < 5%)')
  })

  test('shows the reclaim window each run actually used, not a per-column "recommendation"', () => {
    const b = { ...withReclaim(), env: { ...withReclaim().env, idleReclaimMs: 300000 } }
    const md = abcMarkdown([{ label: 'A', input: input([step(40)]) }, { label: 'B', input: b }])
    expect(md).toContain('| METAL_IDLE_RECLAIM_MS (run setting) | off | 300000 |')
  })
})

describe('readReportInput', () => {
  test('round-trips what writeReport wrote', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'density-read-')), 'run')
    writeReport(dir, withReclaim(), [], [])
    const back = readReportInput(dir)
    expect(back.env.hostId).toBe('latitude-dal-1')
    expect(back.steps[0].n).toBe(40)
    expect(back.reclaim?.at10?.soakDeltaPerVmMiB).toBe(300.4)
  })

  test('says which directory lacks a report.json, not just ENOENT', () => {
    const empty = mkdtempSync(join(tmpdir(), 'density-noreport-'))
    expect(() => readReportInput(empty)).toThrow(new RegExp(`^${empty} has no report\\.json`))
  })
})

describe('parseAbcRuns', () => {
  const write = (rows: StepRow[]): string => {
    const dir = join(mkdtempSync(join(tmpdir(), 'density-abc-')), 'run')
    writeReport(dir, input(rows), [], [])
    return dir
  }

  test('reads label=dir pairs in order', () => {
    const a = write([step(40)])
    const b = write([step(60)])
    const runs = parseAbcRuns(`A=${a}, B=${b}`)
    expect(runs.map((r) => r.label)).toEqual(['A', 'B'])
    expect(runs[1].input.steps[0].n).toBe(60)
  })

  test('needs at least two runs', () => {
    expect(() => parseAbcRuns(`A=${write([step(40)])}`)).toThrow(/at least two runs/)
  })

  test('rejects a bare path with no label', () => {
    expect(() => parseAbcRuns('a,b')).toThrow(/label=dir/)
  })

  test('names the directory when report.json is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'density-empty-'))
    expect(() => parseAbcRuns(`A=${write([step(40)])},B=${empty}`)).toThrow(/no report\.json/)
  })
})

describe('writeAbc', () => {
  test('writes abcMarkdown to the given path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'density-abc-out-'))
    const path = join(dir, 'nested', 'abc.md')
    const runs: AbcRun[] = [{ label: 'A', input: input([step(40)]) }, { label: 'B', input: withReclaim() }]
    expect(writeAbc(path, runs)).toBe(path)
    const body = readFileSync(path, 'utf8')
    expect(body).toContain('| | A | B |')
    expect(body).toContain('| host RAM per idle VM @10 min (MiB) | — | 300.4 |')
  })
})
