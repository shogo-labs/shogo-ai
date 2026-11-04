// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Aggregation and the report table (SHO-327).
 *
 * Every run writes `evals/compaction-report.md`: one row per variant with the
 * means, the spend, and the three worst fixtures — so a variant that looks good
 * on the mean and loses the one fact that mattered is visible in the same
 * place.
 */
import type { FixtureVariantResult, VariantSummary } from './types'
import { mean } from './graders'
import { evaluateVariantGate, type CompactionBaseline, type GateResult } from './gate'

function pct(value: number): string {
  return `${value.toFixed(1)}%`
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`
}

/** Collapse one variant's fixture results into the numbers the report and gate use. */
export function summariseVariant(variantId: string, results: FixtureVariantResult[]): VariantSummary {
  const errored = results.filter((r) => r.error)
  const ok = results.filter((r) => !r.error)
  const worst = [...ok]
    .sort((a, b) => a.factRecall - b.factRecall || (a.nextActionMatch ?? 0) - (b.nextActionMatch ?? 0))
    .slice(0, 3)

  const reRead = results.map((r) => r.reReadRate)

  return {
    variantId,
    fixtures: results.length,
    meanFreedPct: mean(ok.map((r) => r.freedPct)),
    meanTokensAfter: mean(ok.map((r) => r.tokensAfter)),
    meanFactRecall: mean(ok.map((r) => r.factRecall)),
    meanNextActionMatch: mean(ok.map((r) => r.nextActionMatch)),
    meanReReadRate: mean(reRead),
    inventedTools: ok.reduce((sum, r) => sum + r.inventedTools, 0),
    meanSummaryChars: mean(ok.map((r) => r.summaryChars)),
    totalCostUsd: results.reduce((sum, r) => sum + r.summarize.costUsd, 0),
    meanLatencyMs: mean(ok.map((r) => r.summarize.latencyMs)),
    worst,
    errors: errored.length,
  }
}

/**
 * Fixtures that **every** variant in the run graded.
 *
 * A slice-driven run (`--append --resume`) leaves uneven coverage. Averaging
 * each variant over whatever it happened to finish credits a variant for the
 * fixtures that were cheap or landed early, so the table and the gate are
 * computed on the intersection — the same sessions seen by every variant — and
 * the report says how many cells that excluded.
 */
export function comparableFixtures(results: FixtureVariantResult[], variantIds: readonly string[]): string[] {
  if (variantIds.length === 0) return []
  const graded = new Map<string, Set<string>>()
  for (const r of results) {
    const seen = graded.get(r.fixtureId) ?? new Set<string>()
    seen.add(r.variantId)
    graded.set(r.fixtureId, seen)
  }
  return [...graded.entries()]
    .filter(([, seen]) => variantIds.every((id) => seen.has(id)))
    .map(([fixtureId]) => fixtureId)
    .sort()
}

export interface ReportInput {
  fixtures: number
  model: string
  summarizerModel: string
  variants: VariantSummary[]
  results: FixtureVariantResult[]
  baseline: VariantSummary | null
  requiredTracks?: Record<string, boolean>
  spendUsd: number
  /** Cells left out of the comparison because not every variant graded them. */
  excludedCells?: number
  date?: string
}

/** The gate verdicts, one per non-baseline variant. */
export function gateAll(input: ReportInput): Record<string, GateResult> {
  const out: Record<string, GateResult> = {}
  for (const variant of input.variants) {
    if (input.baseline && variant.variantId === input.baseline.variantId) continue
    out[variant.variantId] = evaluateVariantGate({
      summary: variant,
      baseline: input.baseline,
      requiredTracks: input.requiredTracks,
    })
  }
  return out
}

/** The markdown report written to `evals/compaction-report.md`. */
export function renderCompactionReport(input: ReportInput): string {
  const date = input.date ?? new Date().toISOString()
  const gates = gateAll(input)
  const lines: string[] = []

  lines.push('# Compaction eval report')
  lines.push('')
  lines.push(`- Run: ${date}`)
  lines.push(`- Fixtures: ${input.fixtures}`)
  lines.push(`- Model under test: \`${input.model}\``)
  lines.push(`- Summarizer: \`${input.summarizerModel}\``)
  lines.push(`- Spend: ${usd(input.spendUsd)}`)
  if (input.excludedCells) {
    lines.push(
      `- Comparison scope: the ${input.fixtures} fixture(s) graded by **every** variant ` +
        `(${input.excludedCells} cell(s) with partial coverage excluded, so no variant is ` +
        'credited for the fixtures it happened to finish)',
    )
  }
  lines.push('')
  lines.push(
    'Wire tokens measured **after every layer** (`buildHistory` → tool-result budget → microcompact → snip). ' +
      '`freed` is against the same fixture before compaction.',
  )
  lines.push('')
  lines.push('| Variant | fixtures | freed | tokens after | fact recall | next action | re-read | invented | summary chars | cost | latency | errors |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const v of input.variants) {
    lines.push(
      `| **${v.variantId}** | ${v.fixtures} | ${pct(v.meanFreedPct)} | ${Math.round(v.meanTokensAfter).toLocaleString('en-US')} | ` +
        `${pct(v.meanFactRecall * 100)} | ${pct(v.meanNextActionMatch * 100)} | ${pct(v.meanReReadRate * 100)} | ` +
        `${v.inventedTools} | ${Math.round(v.meanSummaryChars).toLocaleString('en-US')} | ${usd(v.totalCostUsd)} | ` +
        `${Math.round(v.meanLatencyMs)} ms | ${v.errors} |`,
    )
  }

  if (input.baseline) {
    lines.push('')
    lines.push(`## Gate against ${input.baseline.variantId}`)
    lines.push('')
    for (const [variantId, gate] of Object.entries(gates)) {
      lines.push(`### ${variantId} — ${gate.ok ? 'PASS' : 'FAIL'}`)
      lines.push('')
      for (const check of gate.checks) {
        lines.push(`- ${check.ok ? '✅' : '❌'} \`${check.name}\`: ${check.detail}`)
      }
      lines.push('')
    }
  }

  lines.push('## Worst fixtures')
  lines.push('')
  for (const v of input.variants) {
    if (v.worst.length === 0) continue
    lines.push(`**${v.variantId}**`)
    lines.push('')
    lines.push('| fixture | fact recall | next action | freed | dropped | note |')
    lines.push('|---|---|---|---|---|---|')
    for (const w of v.worst) {
      lines.push(
        `| ${w.fixtureId} | ${pct(w.factRecall * 100)} | ${w.nextActionMatch === null ? '—' : pct(w.nextActionMatch * 100)} | ` +
          `${pct(w.freedPct)} | ${w.droppedResults} | ${w.error ?? w.nextActionDetail ?? ''} |`,
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** The baseline a run records: variant A's summary, per model. */
export function buildBaseline(
  input: { model: string; summarizerModel: string; fixtures: number },
  summary: VariantSummary,
  variants: VariantSummary[],
  date = new Date().toISOString(),
): CompactionBaseline {
  return {
    model: input.summarizerModel,
    date,
    fixtures: input.fixtures,
    baseline: summary,
    variants: Object.fromEntries(variants.map((v) => [v.variantId, v])),
    notes: `Agent model ${input.model}`,
  }
}
