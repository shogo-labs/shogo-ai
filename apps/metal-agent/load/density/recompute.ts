// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-derive a recorded run's report from its own CSVs.
 *
 * The verdict and knee rules are the part of this harness that a live run keeps
 * disproving, and a run costs 2 h of host time. Everything the rules need is in
 * `steps.csv` and `turns.csv`, so a rule change can be applied to a run that
 * already happened — visibly, from the recorded numbers, rather than by editing
 * the markdown by hand.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { percentile } from './host-sampler'
import { TURN_STEPS, computeKnees, DEFAULT_BOUNDS, evaluateStep, ramCeilingsBySize, type Bounds, type TurnStep } from './knee'
import { perVmRssMiB, renderReportMarkdown, type BurstRow, type ReportInput, type RunEnv, type StepRow } from './report'

type Row = Record<string, string>

/** Split a CSV whose fields never contain commas or quotes (all our columns are numbers/ids). */
export function parseCsv(text: string): Row[] {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []
  const head = lines[0].split(',')
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    const row: Row = {}
    for (let i = 0; i < head.length; i++) row[head[i]] = cells[i] ?? ''
    return row
  })
}

const n = (v: string | undefined) => (v === undefined || v === '' ? 0 : Number(v))

export function stepsFromCsv(text: string, bounds: Bounds = DEFAULT_BOUNDS): StepRow[] {
  const base = { cpu: 0, install: 0, build: 0 } as Record<TurnStep, number>
  return parseCsv(text).map((r) => {
    const turnP95 = {} as Record<TurnStep, number>
    const turnP50 = {} as Record<TurnStep, number>
    for (const s of TURN_STEPS) {
      turnP95[s] = n(r[`${s}_p95_ms`])
      turnP50[s] = n(r[`${s}_p50_ms`])
    }
    const metrics = {
      n: n(r.n),
      turnP95,
      cpuPsiSomeAvg60: n(r.cpu_psi_some_avg60),
      resumeP95Ms: n(r.resume_p95_ms),
      oomKills: n(r.oom_kills),
      swapInPagesPerSec: n(r.swap_in_pages_per_s),
      memPsiFullAvg60: n(r.mem_psi_full_avg60),
      memAvailablePct: n(r.mem_available_pct),
    }
    return {
      ...metrics,
      cpuOversubRatio: n(r.cpu_oversub_ratio),
      ramCommittedMiB: n(r.ram_committed_mib),
      ramPhysicalMiB: n(r.ram_physical_mib),
      // Runs recorded before the column existed wrote host-wide RSS there, so an
      // absent value means `host-wide`, never a soak-attributable zero.
      ramPhysicalBasis: r.ram_physical_basis === 'soak-delta' ? 'soak-delta' : 'host-wide',
      turnP50,
      runDelayP95MsPerSec: n(r.run_delay_p95_ms_per_s),
      apiP95Ms: n(r.api_p95_ms),
      verdict: evaluateStep(metrics, base, bounds),
    }
  })
}

/** The N=1 turns, at p95 — the stat the bounds are applied to. */
export function baselineFromCsv(text: string): Record<TurnStep, number> | null {
  const rows = parseCsv(text).filter((r) => r.n === '1' && r.role === 'agent' && r.ok === 'true')
  if (rows.length === 0) return null
  const out = {} as Record<TurnStep, number>
  for (const s of TURN_STEPS) out[s] = +percentile(rows.map((r) => n(r[`${s}_ms`])), 95).toFixed(1)
  return out
}

export function burstFromCsv(text: string): BurstRow[] {
  return parseCsv(text).map((r) => {
    const turnP95 = {} as Record<TurnStep, number>
    for (const s of TURN_STEPS) turnP95[s] = n(r[`${s}_p95_ms`])
    return {
      n: n(r.n),
      fraction: n(r.fraction),
      windowMs: n(r.window_ms),
      turnsStarted: n(r.turns_started),
      turnP95,
      cpuPsiSomeAvg60: n(r.cpu_psi_some_avg60),
      memAvailablePct: n(r.mem_available_pct),
      oomKills: n(r.oom_kills),
      resumeP95Ms: n(r.resume_p95_ms),
      pass: r.pass === 'pass',
    }
  })
}

/**
 * Rewrite `<dir>/report.md` from the run's own CSVs with the current rules.
 * Returns the knees it derived, so a caller can print them.
 */
export function recomputeReport(dir: string, bounds: Bounds = DEFAULT_BOUNDS): { report: ReportInput; path: string } {
  const env = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')) as RunEnv
  const steps = stepsFromCsv(readFileSync(join(dir, 'steps.csv'), 'utf8'), bounds)
  const baseline = baselineFromCsv(readFileSync(join(dir, 'turns.csv'), 'utf8'))
  if (!baseline) {
    throw new Error(`${dir}/turns.csv has no N=1 rows (a run recorded before the p95 baseline); re-run the soak instead of recomputing`)
  }
  // Re-evaluate against the real baseline; stepsFromCsv used a zero baseline,
  // which makes every ratio infinite and every step fail.
  const evaluated = steps.map((s) => ({ ...s, verdict: evaluateStep(s, baseline, bounds) }))
  const burstPath = join(dir, 'burst.csv')
  const burst = existsSync(burstPath) ? burstFromCsv(readFileSync(burstPath, 'utf8')) : []
  const knees = computeKnees(evaluated, baseline, bounds)
  const rssMiB = perVmRssMiB(evaluated)

  const report: ReportInput = {
    env,
    baseline,
    steps: evaluated,
    burst,
    knees,
    recommendation: {
      maxVmsPerHost: knees.recommended,
      cpuKnee: knees.cpuKnee,
      ramKnee: knees.ramKnee,
      bySize: rssMiB > 0 ? ramCeilingsBySize({ hostMemMiB: env.hostMemMiB, perVmRssMiB: rssMiB, reservePct: bounds.memAvailablePct }) : [],
      perVmRssMiB: rssMiB,
    },
    mix: { agent: 0.16, app: 0.01, idle: 0.83 },
    notes: [
      `Re-derived from steps.csv and turns.csv of the recorded run (${env.startedAt}), not a fresh soak.`,
      burst.length === 0
        ? 'This run recorded no burst rows, so none are claimed here; the burst evidence lives in the run whose burst.csv is committed.'
        : `Burst rows: ${burst.length}.`,
    ],
  }
  // A recompute that cannot reproduce the burst must not overwrite a report that
  // has one: write beside it, so the recorded burst result survives.
  const target = join(dir, 'report.md')
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
  const path = burst.length === 0 && /^## Burst$/m.test(existing) ? join(dir, 'report.recomputed.md') : target
  writeFileSync(path, renderReportMarkdown(report))
  return { report, path }
}
