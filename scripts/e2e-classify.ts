#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Attributes a hosted-e2e run to the platform or to the product (SHO-136).
 *
 * Reads the Playwright JSON report plus the two capacity probes the
 * `preflight` / `postrun` jobs wrote (see
 * .github/scripts/probe-staging-capacity.sh) and prints:
 *
 *   classification=environment|product|unknown|clean
 *   annotation=environment: node 10.0.24.140 at 74% nodefs
 *
 * Writes the same markdown the workflow renders to $GITHUB_STEP_SUMMARY and the
 * `classification` / `annotation` / `degraded` / `platform` outputs to
 * $GITHUB_OUTPUT.
 *
 * An `environment:` or `unknown:` classification is a platform defect, never a
 * pass: the `classify` job turns both into a warning annotation and a platform
 * issue. `unknown` is a red run with no parseable report — the JSON reporter
 * only writes at the end, so a job killed at its timeout files nothing.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs'
import {
  type CapacityProbe,
  type FailedSpec,
  classifyE2eRun,
  collectFailedSpecs,
  degradedRetryNote,
  isPlatformClassification,
} from './lib/e2e-classification'

interface Options {
  report?: string
  before?: string
  after?: string
  previous?: string
  outcome: string
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { outcome: 'failure' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === '--report') opts.report = value
    else if (arg === '--before') opts.before = value
    else if (arg === '--after') opts.after = value
    else if (arg === '--previous') opts.previous = value
    else if (arg === '--outcome') opts.outcome = value
    else continue
    i += 1
  }
  return opts
}

/** A probe file that is missing is not a breach — it is simply unknown. */
export function readProbe(path: string | undefined): CapacityProbe | undefined {
  if (!path || !existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CapacityProbe>
    return {
      diskOk: parsed.diskOk !== false,
      diskReason: parsed.diskReason,
      warmPoolOk: parsed.warmPoolOk !== false,
      warmPoolReason: parsed.warmPoolReason,
      studioRevisionOk: parsed.studioRevisionOk !== false,
      studioRevisionReason: parsed.studioRevisionReason,
      healthOk: parsed.healthOk !== false,
      healthReason: parsed.healthReason,
    }
  } catch {
    return undefined
  }
}

export function readReport(path: string | undefined): FailedSpec[] {
  if (!path || !existsSync(path)) return []
  try {
    return collectFailedSpecs(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return []
  }
}

export function renderSummary(result: ReturnType<typeof classifyE2eRun>, opts: Options): string {
  const lines: string[] = ['### E2E attribution', '']
  if (result.kind === 'clean') {
    lines.push('`clean` — no spec failures, no capacity breach.')
  } else {
    lines.push(`**\`${result.annotation}\`**`, '')
    for (const reason of result.reasons) lines.push(`- ${reason}`)
  }
  if (result.productSpecs.length > 0) {
    lines.push('', 'Product failures:', ...result.productSpecs.map((spec) => `- ${spec}`))
  }
  if (opts.outcome !== 'success') {
    lines.push('', `Probes: before=\`${opts.before ?? 'none'}\` after=\`${opts.after ?? 'none'}\``)
  }
  if (result.kind === 'environment') {
    lines.push('', '> platform defect: this is the cluster failing to carry the load, not a broken spec.')
  } else if (result.kind === 'unknown') {
    lines.push(
      '',
      '> platform defect: the run is red but produced no parseable report — it cannot be called clean.',
    )
  }
  return `${lines.join('\n')}\n`
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2))
  const result = classifyE2eRun({
    failures: readReport(opts.report),
    before: readProbe(opts.before),
    after: readProbe(opts.after),
    outcome: opts.outcome,
  })

  // A run that passed after a red first attempt is reported as degraded, never
  // as a clean green (`degradedRetryNote`), in both the summary and the status.
  const retried = opts.previous !== undefined && opts.previous !== ''
  const note = retried ? degradedRetryNote(opts.previous) : ''

  const summary = renderSummary(result, opts)
  console.log(summary)
  if (retried) console.log(`\n${note}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, retried ? `${summary}\n${note}\n` : summary)
  }
  if (process.env.GITHUB_OUTPUT) {
    const outputs = [
      `classification=${result.kind}`,
      `annotation=${result.annotation}`,
      `degraded=${note}`,
      // One flag the workflow gates on, so `unknown` cannot be forgotten at a
      // second call site the way a bare `== 'environment'` comparison can.
      `platform=${isPlatformClassification(result.kind)}`,
    ]
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`)
  }
  if (isPlatformClassification(result.kind)) {
    console.log(`::warning::${result.annotation}`)
  }
}
