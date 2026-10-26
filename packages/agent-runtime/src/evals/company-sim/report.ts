// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ablation report for company-sim runs.
 *
 *   bun run src/evals/company-sim/report.ts <results.json> [more results.json...]
 *
 * Groups trials by scenario and arm and prints, per scenario: mean score,
 * pass rate, pass^k (every trial passed), and the A−B (boards vs chat only)
 * and A−C (history vs none) score deltas. History-dependent criteria get
 * their own pass rates, since that is where arm C should fall behind.
 */
import { readFileSync } from 'fs'
import { COMPANY_SIM_SCENARIOS } from './scenarios'
import type { Arm } from './world'

export interface TrialRow {
  scenario: string
  arm: Arm
  percentage: number
  passed: boolean
  criteria: Record<string, boolean>
}

export interface ArmStats { n: number; meanPct: number; passRate: number; passAllK: boolean; historyPassRate: number | null }
export interface ScenarioReport { scenario: string; arms: Partial<Record<Arm, ArmStats>>; deltaAB: number | null; deltaAC: number | null }

/** `sim-support-reopen--a#t2` → { scenario: 'support-reopen', arm: 'A' } */
export function parseSimId(id: string): { scenario: string; arm: Arm } | null {
  const m = /^sim-(.+)--([abc])(?:#t\d+)?$/.exec(id)
  return m ? { scenario: m[1], arm: m[2].toUpperCase() as Arm } : null
}

export function rowsFromResults(json: { results?: Array<any> }): TrialRow[] {
  const rows: TrialRow[] = []
  for (const r of json.results ?? []) {
    const parsed = parseSimId(String(r.eval?.id ?? ''))
    if (!parsed) continue
    const criteria: Record<string, boolean> = {}
    for (const c of r.criteriaResults ?? []) if (c.criterion?.id) criteria[c.criterion.id] = !!c.passed
    rows.push({ ...parsed, percentage: Number(r.percentage) || 0, passed: !!r.passed, criteria })
  }
  return rows
}

export function buildReport(rows: TrialRow[]): ScenarioReport[] {
  const historyCriteria = new Map(COMPANY_SIM_SCENARIOS.map((s) => [s.id, s.historyDependent ?? []]))
  const scenarios = [...new Set(rows.map((r) => r.scenario))]
  return scenarios.map((scenario) => {
    const arms: Partial<Record<Arm, ArmStats>> = {}
    for (const arm of ['A', 'B', 'C'] as Arm[]) {
      const trials = rows.filter((r) => r.scenario === scenario && r.arm === arm)
      if (!trials.length) continue
      const hist = historyCriteria.get(scenario) ?? []
      const histResults = trials.flatMap((t) => hist.filter((h) => h in t.criteria).map((h) => t.criteria[h]))
      arms[arm] = {
        n: trials.length,
        meanPct: mean(trials.map((t) => t.percentage)),
        passRate: trials.filter((t) => t.passed).length / trials.length,
        passAllK: trials.every((t) => t.passed),
        historyPassRate: histResults.length ? histResults.filter(Boolean).length / histResults.length : null,
      }
    }
    const d = (x?: ArmStats, y?: ArmStats) => (x && y ? x.meanPct - y.meanPct : null)
    return { scenario, arms, deltaAB: d(arms.A, arms.B), deltaAC: d(arms.A, arms.C) }
  })
}

export function formatReport(report: ScenarioReport[]): string {
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '   -' : `${Math.round(v).toString().padStart(4)}`)
  const rate = (v: number | null | undefined) => (v === null || v === undefined ? '   -' : `${Math.round(v * 100).toString().padStart(3)}%`)
  const lines = ['scenario                         A score  B score  C score  A pass  B pass  C pass  A-B   A-C   hist A/B/C']
  for (const r of report) {
    const { A, B, C } = r.arms
    lines.push([
      r.scenario.padEnd(32),
      `${pct(A?.meanPct)}%  `, `${pct(B?.meanPct)}%  `, `${pct(C?.meanPct)}%  `,
      `${rate(A?.passRate)}${A?.passAllK ? '*' : ' '} `, `${rate(B?.passRate)}${B?.passAllK ? '*' : ' '} `, `${rate(C?.passRate)}${C?.passAllK ? '*' : ' '} `,
      `${pct(r.deltaAB)} `, `${pct(r.deltaAC)} `,
      ` ${rate(A?.historyPassRate)}/${rate(B?.historyPassRate)}/${rate(C?.historyPassRate)}`,
    ].join(''))
  }
  const all = (arm: Arm) => report.map((r) => r.arms[arm]?.meanPct).filter((v): v is number => v !== undefined)
  lines.push('', `overall mean score: A ${pct(mean(all('A')))}%  B ${pct(mean(all('B')))}%  C ${pct(mean(all('C')))}%`, '(* = pass^k: every trial passed)')
  return lines.join('\n')
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

if (import.meta.main) {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('usage: bun run src/evals/company-sim/report.ts <results.json> [...]')
    process.exit(1)
  }
  const rows = files.flatMap((f) => rowsFromResults(JSON.parse(readFileSync(f, 'utf8'))))
  console.log(formatReport(buildReport(rows)))
}
