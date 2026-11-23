// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The density soak's output: one directory per run with the raw series, the
 * per-step table, the burst rows, both knees and the recommendation.
 *
 * The renderers are pure (string in, string out) so the markdown and CSV can be
 * asserted in a unit test without touching the filesystem.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { HostSample } from './host-sampler'
import { TURN_STEPS, type Knees, type StepMetrics, type StepVerdict, type TurnStep } from './knee'

/**
 * What `ramPhysicalMiB` counts. `soak-delta` is the host's Firecracker RSS
 * minus the RSS recorded before the soak added a guest, so it is the soak's own
 * share. `host-wide` is every Firecracker process on the host, tenants
 * included — it is not attributable to the soak and must not be divided by N.
 * Steps.csv rows written before the column existed are `host-wide`, because
 * that is what the old code recorded.
 */
export type RamPhysicalBasis = 'soak-delta' | 'host-wide'

export interface StepRow extends StepMetrics {
  /** vCPUs committed / physical threads. */
  cpuOversubRatio: number
  /** Guest RAM committed (N × configured MiB) and host RAM physically used. */
  ramCommittedMiB: number
  ramPhysicalMiB: number
  ramPhysicalBasis: RamPhysicalBasis
  turnP50: Record<TurnStep, number>
  runDelayP95MsPerSec: number
  apiP95Ms: number
  verdict: StepVerdict
}

/**
 * Host RSS per resident soak VM, taken from the densest step whose RAM was
 * attributed to the soak. 0 when no step carries an attributable number — the
 * card's per-size table is only meaningful when this is measured, never
 * inferred from host-wide RSS.
 */
export function perVmRssMiB(steps: StepRow[]): number {
  const attributed = steps
    .filter((s) => s.ramPhysicalBasis === 'soak-delta' && s.n > 0 && s.ramPhysicalMiB > 0)
    .sort((a, b) => b.n - a.n)
  const top = attributed[0]
  return top ? Math.round(top.ramPhysicalMiB / top.n) : 0
}

export interface BurstRow {
  n: number
  fraction: number
  windowMs: number
  turnsStarted: number
  turnP95: Record<TurnStep, number>
  cpuPsiSomeAvg60: number
  memAvailablePct: number
  oomKills: number
  resumeP95Ms: number
  pass: boolean
}

export interface RunEnv {
  hostId: string
  hostModel: string
  kernel: string
  firecrackerVersion: string
  gitSha: string
  region: string
  controlPlaneUrl: string
  vcpus: number
  memMiB: number
  hostMemMiB: number
  hostThreads: number
  maxVmsPerHost: number
  idleSuspendMs: number
  startedAt: string
  finishedAt?: string
  abortReason?: string
}

export interface ReportInput {
  env: RunEnv
  baseline: Record<TurnStep, number>
  steps: StepRow[]
  burst: BurstRow[]
  knees: Knees
  recommendation: {
    maxVmsPerHost: number
    cpuKnee: number
    ramKnee: number
    bySize: { sizeMiB: number; maxVms: number }[]
    perVmRssMiB: number
  }
  mix: { agent: number; app: number; idle: number }
  notes?: string[]
}

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—')

export function stepsCsv(rows: StepRow[]): string {
  const head = [
    'n',
    'cpu_oversub_ratio',
    'ram_committed_mib',
    'ram_physical_mib',
    'ram_physical_basis',
    ...TURN_STEPS.flatMap((s) => [`${s}_p50_ms`, `${s}_p95_ms`]),
    'run_delay_p95_ms_per_s',
    'cpu_psi_some_avg60',
    'mem_available_pct',
    'swap_in_pages_per_s',
    'oom_kills',
    'mem_psi_full_avg60',
    'resume_p95_ms',
    'api_p95_ms',
    'cpu_pass',
    'ram_pass',
  ]
  const lines = rows.map((r) =>
    [
      r.n,
      f(r.cpuOversubRatio, 2),
      r.ramCommittedMiB,
      r.ramPhysicalMiB,
      r.ramPhysicalBasis,
      ...TURN_STEPS.flatMap((s) => [f(r.turnP50[s]), f(r.turnP95[s])]),
      f(r.runDelayP95MsPerSec, 2),
      f(r.cpuPsiSomeAvg60, 2),
      f(r.memAvailablePct, 1),
      f(r.swapInPagesPerSec, 1),
      r.oomKills,
      f(r.memPsiFullAvg60, 2),
      f(r.resumeP95Ms, 0),
      f(r.apiP95Ms, 0),
      r.verdict.cpuPass,
      r.verdict.ramPass,
    ].join(','),
  )
  return [head.join(','), ...lines].join('\n') + '\n'
}

export function samplesCsv(samples: HostSample[]): string {
  const head = [
    'ts',
    'mem_total_mib',
    'mem_available_mib',
    'mem_available_pct',
    'swap_free_mib',
    'cpu_psi_some_avg60',
    'mem_psi_full_avg60',
    'load1',
    'procs_running',
    'fc_procs',
    'fc_rss_mib',
    'run_delay_p95_ms_per_s',
    'swap_in_pages_per_s',
  ]
  const lines = samples.map((s) =>
    [
      s.ts,
      s.mem?.totalMiB ?? '',
      s.mem?.availableMiB ?? '',
      s.memAvailablePct ?? '',
      s.mem?.swapFreeMiB ?? '',
      s.cpuPressure?.some60 ?? '',
      s.memPressure?.full60 ?? '',
      s.load?.load1 ?? '',
      s.load?.procsRunning ?? '',
      s.fcProcs,
      s.fcRssMiB,
      s.runDelayMsPerSec?.p95 ?? '',
      s.swapInPagesPerSec ?? '',
    ].join(','),
  )
  return [head.join(','), ...lines].join('\n') + '\n'
}

export function turnsCsv(turns: { n: number; role: string; projectId: string; t: Record<string, number | boolean | string | undefined> }[]): string {
  const head = ['n', 'role', 'project_id', 'cpu_ms', 'install_ms', 'build_ms', 'git_ms', 'llm_wait_ms', 'ok', 'error']
  const lines = turns.map((r) =>
    [r.n, r.role, r.projectId, r.t.cpuMs ?? '', r.t.installMs ?? '', r.t.buildMs ?? '', r.t.gitMs ?? '', r.t.llmWaitMs ?? '', r.t.ok ?? '', (r.t.error as string) ?? ''].join(','),
  )
  return [head.join(','), ...lines].join('\n') + '\n'
}

export function renderReportMarkdown(input: ReportInput): string {
  const { env, baseline, steps, burst, knees, recommendation, mix } = input
  const out: string[] = []

  out.push(`# Metal density soak — ${env.hostId} — ${env.startedAt}`)
  out.push('')
  out.push(
    recommendation.maxVmsPerHost > 0
      ? `**Recommendation: \`METAL_MAX_VMS_PER_HOST=${recommendation.maxVmsPerHost}\`** at ${env.memMiB} MiB / ${env.vcpus} vCPU VMs.`
      : '**No recommendation:** no measured density met the bounds. That is a failed measurement, not a host that cannot run VMs — inspect the failing steps before setting a cap.',
  )
  out.push('')
  out.push(`CPU knee **${recommendation.cpuKnee}**, RAM knee **${recommendation.ramKnee}** — the recommendation is the lower of the two.`)
  out.push('')
  if (env.abortReason) {
    out.push(`> **Run aborted early:** ${env.abortReason}`)
    out.push('')
  }

  out.push('## Host')
  out.push('')
  out.push('| | |')
  out.push('|---|---|')
  out.push(`| host | \`${env.hostId}\` (${env.region}) |`)
  out.push(`| model | ${env.hostModel} |`)
  out.push(`| kernel | ${env.kernel} |`)
  out.push(`| firecracker | ${env.firecrackerVersion} |`)
  out.push(`| threads / RAM | ${env.hostThreads} / ${env.hostMemMiB} MiB |`)
  out.push(`| VM sizing | ${env.vcpus} vCPU / ${env.memMiB} MiB |`)
  out.push(`| env at start | METAL_MAX_VMS_PER_HOST=${env.maxVmsPerHost}, METAL_IDLE_SUSPEND_MS=${env.idleSuspendMs} |`)
  out.push(`| git sha | \`${env.gitSha}\` |`)
  out.push(`| mix | agent ${(mix.agent * 100).toFixed(0)}% / app ${(mix.app * 100).toFixed(0)}% / idle ${(mix.idle * 100).toFixed(0)}% |`)
  out.push('')

  out.push('## Baseline (N=1)')
  out.push('')
  out.push('| step | p95 ms |')
  out.push('|---|---|')
  for (const s of TURN_STEPS) out.push(`| ${s} | ${f(baseline[s])} |`)
  out.push('')

  out.push('## Steps')
  out.push('')
  const anyHostWide = steps.some((r) => r.ramPhysicalBasis === 'host-wide')
  out.push(
    '| N | vCPU over | RAM committed | RAM physical ' +
      (anyHostWide ? '(host FC, not soak) | ' : '(soak) | ') +
      TURN_STEPS.map((s) => `${s} p95`).join(' | ') +
      ' | run_delay p95 | cpu PSI | MemAvail | swap-in/s | OOM | mem PSI full | resume p95 | API p95 | CPU | RAM |',
  )
  out.push('|' + '---|'.repeat(12 + TURN_STEPS.length))
  for (const r of steps) {
    out.push(
      `| ${r.n} | ${f(r.cpuOversubRatio, 2)}:1 | ${r.ramCommittedMiB} MiB | ${r.ramPhysicalMiB} MiB | ` +
        TURN_STEPS.map((s) => `${f(r.turnP95[s])} ms`).join(' | ') +
        ` | ${f(r.runDelayP95MsPerSec, 2)} | ${f(r.cpuPsiSomeAvg60)}% | ${f(r.memAvailablePct)}% | ${f(r.swapInPagesPerSec)} | ${r.oomKills} | ${f(r.memPsiFullAvg60)}% | ${f(r.resumeP95Ms, 0)} ms | ${f(r.apiP95Ms, 0)} ms | ${r.verdict.cpuPass ? 'pass' : 'FAIL'} | ${r.verdict.ramPass ? 'pass' : 'FAIL'} |`,
    )
  }
  out.push('')
  if (anyHostWide) {
    out.push(
      '> The RAM physical column in this run is the host\'s whole Firecracker RSS, tenants included — it was recorded before the harness attributed RSS to the soak, so it cannot be read per VM. Use the committed run that carries `ram_physical_basis=soak-delta` for host RSS per VM.',
    )
    out.push('')
  }

  const failures = steps.filter((r) => !r.verdict.cpuPass || !r.verdict.ramPass)
  if (failures.length > 0) {
    out.push('### Why each step failed')
    out.push('')
    for (const r of failures) {
      const reasons = [...r.verdict.cpuReasons, ...r.verdict.ramReasons]
      out.push(`- **N=${r.n}**: ${reasons.join('; ')}`)
    }
    out.push('')
  }

  if (burst.length > 0) {
    out.push('## Burst')
    out.push('')
    out.push('| N | fraction | window | turns started | ' + TURN_STEPS.map((s) => `${s} p95`).join(' | ') + ' | cpu PSI | MemAvail | OOM | resume p95 | pass |')
    out.push('|' + '---|'.repeat(7 + TURN_STEPS.length))
    for (const b of burst) {
      out.push(
        `| ${b.n} | ${(b.fraction * 100).toFixed(0)}% | ${Math.round(b.windowMs / 1000)}s | ${b.turnsStarted} | ` +
          TURN_STEPS.map((s) => `${f(b.turnP95[s])} ms`).join(' | ') +
          ` | ${f(b.cpuPsiSomeAvg60)}% | ${f(b.memAvailablePct)}% | ${b.oomKills} | ${f(b.resumeP95Ms, 0)} ms | ${b.pass ? 'pass' : 'FAIL'} |`,
      )
    }
    out.push('')
  }

  out.push('## Knees')
  out.push('')
  out.push(
    `- **CPU knee: ${knees.cpuKnee}** — the highest N whose turn-step p95 stayed within 1.5× the baseline, CPU PSI \`some avg60\` stayed under the limit, and resume p95 held the 2 s SLO.`,
  )
  out.push(
    `- **RAM knee: ${knees.ramKnee}** — the highest N with zero OOM kills, no sustained swap-in, memory PSI \`full avg60\` under the limit, and MemAvailable above the floor.`,
  )
  const top = steps.length > 0 ? Math.max(...steps.map((r) => r.n)) : 0
  const belowKnee = steps.filter((r) => r.n < recommendation.maxVmsPerHost && (!r.verdict.cpuPass || !r.verdict.ramPass))
  if (belowKnee.length > 0) {
    out.push(
      `- **Below the knee:** ${belowKnee.map((r) => `N=${r.n}`).join(', ')} missed a bound while a higher N passed the same bounds. A step that fails below a passing step is not a capacity limit — the queue, the page cache or one slow turn at that N explains it — so the passing step above it is the measurement.`,
    )
  }
  if (top > 0 && recommendation.maxVmsPerHost > 0 && recommendation.maxVmsPerHost === top) {
    out.push(`- **No knee found:** every step up to N=${top} passed. The ladder stopped there, not the host.`)
  }
  out.push(
    recommendation.maxVmsPerHost > 0
      ? `- **Recommended \`METAL_MAX_VMS_PER_HOST\`: ${recommendation.maxVmsPerHost}** = min(${recommendation.cpuKnee}, ${recommendation.ramKnee}).`
      : '- **Recommended `METAL_MAX_VMS_PER_HOST`: none** — a knee of 0 means no measured step passed the bounds; it is not a capacity of zero.',
  )
  out.push('')

  out.push('## RAM at each prod VM size')
  out.push('')
  if (recommendation.perVmRssMiB > 0) {
    out.push(`Measured host RSS per resident VM: **${recommendation.perVmRssMiB} MiB**.`)
    out.push('')
    out.push('| configured VM size | max VMs in host RAM |')
    out.push('|---|---|')
    for (const s of recommendation.bySize) out.push(`| ${s.sizeMiB} MiB | ${s.maxVms} |`)
  } else {
    out.push(
      'Not measured in this run: no step carries host RSS attributed to the soak, and host-wide Firecracker RSS cannot be divided by N while tenants are resident. The per-size table comes from a run that records `ram_physical_basis=soak-delta`.',
    )
  }
  out.push('')

  if (input.notes && input.notes.length > 0) {
    out.push('## Notes')
    out.push('')
    for (const n of input.notes) out.push(`- ${n}`)
    out.push('')
  }

  return out.join('\n')
}

export interface WrittenReport {
  dir: string
  files: string[]
}

/** One row per burst, so a recompute does not lose the burst result. */
export function burstCsv(rows: BurstRow[]): string {
  const head = [
    'n',
    'fraction',
    'window_ms',
    'turns_started',
    ...TURN_STEPS.map((s) => `${s}_p95_ms`),
    'cpu_psi_some_avg60',
    'mem_available_pct',
    'oom_kills',
    'resume_p95_ms',
    'pass',
  ]
  const lines = rows.map((b) =>
    [
      b.n,
      b.fraction,
      b.windowMs,
      b.turnsStarted,
      ...TURN_STEPS.map((s) => b.turnP95[s]),
      b.cpuPsiSomeAvg60,
      b.memAvailablePct,
      b.oomKills,
      b.resumeP95Ms,
      b.pass ? 'pass' : 'FAIL',
    ].join(','),
  )
  return [head.join(','), ...lines].join('\n') + '\n'
}

/** Write the whole run directory. */
export function writeReport(dir: string, input: ReportInput, samples: HostSample[], turns: Parameters<typeof turnsCsv>[0]): WrittenReport {
  mkdirSync(dir, { recursive: true })
  const files: Record<string, string> = {
    'steps.csv': stepsCsv(input.steps),
    'burst.csv': burstCsv(input.burst),
    'samples.csv': samplesCsv(samples),
    'turns.csv': turnsCsv(turns),
    'report.md': renderReportMarkdown(input),
    'env.json': JSON.stringify(input.env, null, 2) + '\n',
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return { dir, files: Object.keys(files) }
}
