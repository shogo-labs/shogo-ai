// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `bun run evals:compaction` — the compaction eval CLI (SHO-327).
 *
 *   bun run evals:compaction --fixtures synthetic          # CI: 6 committed fixtures
 *   bun run evals:compaction --fixtures real --variants A,B1,D
 *   bun run evals:compaction --max-usd 25 --write-baseline
 *   bun run evals:compaction --report-only --append      # re-render, spend $0
 *   bun run evals:compaction --tracks context-retention=true,cache-compaction-recovery=true --gate
 *
 * `--tracks` is what this run actually executed. A track that is not declared
 * reads as `not run` and fails the gate — an unrun guard is not a passing one.
 *
 * Prints the report table and the actual spend, writes
 * `evals/compaction-report.md`, and refuses to spend past `--max-usd`
 * (default 25).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Message } from '@mariozechner/pi-ai'
import { createCompactionSummarizer } from '../../compaction-summarizer'
import { renderTranscriptForSummary } from '../../compaction-transcript'
import { COMPACTION_VARIANTS, type CompactionVariantConfig, type CompactionVariantId } from '../../compaction-variants'
import { syntheticFixtures } from './fixtures'
import { createShogoChatClient } from './model-client'
import { runFixtureVariant, type CompactionEvalDeps, type SummarizeStats } from './runner'
import { buildBaseline, comparableFixtures, renderCompactionReport, summariseVariant } from './report'
import { evaluateVariantGate, parseRequiredTracks } from './gate'
import type { CompactionFixture, FixtureVariantResult } from './types'

const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
// Written by `scripts/export-compaction-fixtures.ts`; gitignored.
const FIXTURE_DIR = join(import.meta.dir, '..', 'fixtures', 'compaction')
const REPORT_PATH = join(REPO_ROOT, 'evals', 'compaction-report.md')
const BASELINE_PATH = join(import.meta.dir, 'compaction-baseline.json')

const DEFAULT_VARIANTS: CompactionVariantId[] = ['A', 'B0', 'B1', 'B2', 'C', 'D']
/** Hoshi 2.0 is the production summarizer; the id is the gateway's. */
const DEFAULT_SUMMARIZER = '4fa677d1-e4a6-4ea1-88b5-e57101e810cd'
const DEFAULT_MODEL = '4fa677d1-e4a6-4ea1-88b5-e57101e810cd'

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1]
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/**
 * Real fixtures exported by `scripts/export-compaction-fixtures.ts`. Read-only.
 *
 * `offset`/`limit` slice the file list **before** parsing: a full export is tens
 * of megabytes of transcripts, and a run that slices afterwards holds all of it
 * in memory for no reason.
 */
export function loadRealFixtures(dir = FIXTURE_DIR, opts: { offset?: number; limit?: number } = {}): CompactionFixture[] {
  if (!existsSync(dir)) return []
  const offset = Math.max(0, opts.offset ?? 0)
  const limit = opts.limit ?? Number.MAX_SAFE_INTEGER
  const out: CompactionFixture[] = []
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(offset, offset + limit)
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as CompactionFixture
      if (Array.isArray(parsed.messages) && parsed.nextUserMessage) out.push(parsed)
    } catch {
      // A malformed export must not abort a run over the other 23.
    }
  }
  return out
}

/** Cells a previous slice already paid for, so a retry never re-buys them. */
function readCarriedResults(resultsPath: string): FixtureVariantResult[] {
  try {
    const parsed = JSON.parse(readFileSync(resultsPath, 'utf8')) as { results?: FixtureVariantResult[] }
    return parsed.results ?? []
  } catch {
    return []
  }
}

/** Spend already recorded in a previous slice (for --append's total). */
function previousSpend(resultsPath: string): number {
  try {
    const parsed = JSON.parse(readFileSync(resultsPath, 'utf8')) as { spendUsd?: number }
    return Number(parsed.spendUsd ?? 0)
  } catch {
    return 0
  }
}

function zeroStats(): SummarizeStats {
  return {
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, latencyMs: 0 },
    transcriptChars: 0,
    chunks: 0,
  }
}

/** Wire the model client into the summarizer and the probes, tracking spend. */
function buildDeps(opts: {
  summarizerModel: string
  probeModel: string
  spent: { usd: number }
  maxUsd: number
}): CompactionEvalDeps {
  const probe = createShogoChatClient(opts.probeModel)
  let stats = zeroStats()

  const summarizeFor = (variant: CompactionVariantConfig): ReturnType<typeof createCompactionSummarizer> =>
    createCompactionSummarizer({
      model: { id: opts.summarizerModel, provider: 'shogo' },
      omitResultBodies: variant.summaryOmitsResultBodies,
      renderTranscript: (messages: readonly Message[], o: { resultBodies: boolean }) => {
        const rendered = renderTranscriptForSummary(messages, { resultBodies: o.resultBodies })
        stats.transcriptChars += rendered.length
        return rendered
      },
      runSummary: async (input) => {
        stats.chunks++
        const { text, usage } = await probe.complete({
          system: input.system,
          prompt: input.prompt,
          maxTokens: 4_000,
        })
        opts.spent.usd += usage.costUsd
        stats.usage = {
          inputTokens: stats.usage.inputTokens + usage.inputTokens,
          outputTokens: stats.usage.outputTokens + usage.outputTokens,
          cacheReadTokens: stats.usage.cacheReadTokens + usage.cacheReadTokens,
          cacheWriteTokens: stats.usage.cacheWriteTokens + usage.cacheWriteTokens,
          costUsd: stats.usage.costUsd + usage.costUsd,
          latencyMs: stats.usage.latencyMs + usage.latencyMs,
        }
        if (opts.spent.usd > opts.maxUsd) {
          throw new Error(`--max-usd ${opts.maxUsd} reached (spent $${opts.spent.usd.toFixed(4)}) — stopping`)
        }
        return text || '(summary unavailable)'
      },
    })

  return {
    summarizeFor,
    takeSummarizeStats: () => {
      const out = stats
      stats = zeroStats()
      return out
    },
    probe,
    judge: async (rubric, answer) => {
      const { text, usage } = await probe.complete({
        system: 'You grade an answer against a rubric. Reply with exactly PASS or FAIL.',
        prompt: `Rubric:\n${rubric}\n\nAnswer:\n${answer}`,
        maxTokens: 800,
      })
      opts.spent.usd += usage.costUsd
      return /^\s*pass/i.test(text)
    },
  }
}

async function main(): Promise<void> {
  const which = arg('fixtures', 'synthetic')!
  const variantIds = (arg('variants', DEFAULT_VARIANTS.join(','))!
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter((v): v is CompactionVariantId => v in COMPACTION_VARIANTS))
  const maxUsd = Number(arg('max-usd', '25'))
  const summarizerModel = arg('summarizer', DEFAULT_SUMMARIZER)!
  const model = arg('model', DEFAULT_MODEL)!

  // A paid run over every fixture does not fit in one interactive window here,
  // so the real set can be taken in slices and the slices merged with --append.
  const offsetReal = Number(arg('offset-real', '0'))
  const limitReal = arg('limit-real')
  const realAll =
    which === 'real' || which === 'all'
      ? loadRealFixtures(FIXTURE_DIR, { offset: offsetReal, limit: limitReal ? Number(limitReal) : undefined })
      : []
  const fixtures: CompactionFixture[] = [
    ...realAll,
    ...(which === 'synthetic' || which === 'all' ? syntheticFixtures() : []),
  ]
  if (fixtures.length === 0) {
    console.error(
      which === 'real'
        ? `No real fixtures in ${FIXTURE_DIR}. Run: bun scripts/export-compaction-fixtures.ts`
        : 'No fixtures selected.',
    )
    process.exit(1)
  }
  if (variantIds.length === 0) {
    console.error(`No valid variants. Choose from ${Object.keys(COMPACTION_VARIANTS).join(', ')}.`)
    process.exit(1)
  }

  console.log(`Compaction eval — ${fixtures.length} fixture(s), variants ${variantIds.join(', ')}, max $${maxUsd}`)
  const spent = { usd: 0 }
  const deps = buildDeps({ summarizerModel, probeModel: model, spent, maxUsd })
  const results: FixtureVariantResult[] = []

  // Fixture x variant cells are independent and almost entirely network-bound,
  // so they run a few at a time (--concurrency, default 3). Spending is checked
  // before each cell starts; the summarizer also throws past the limit, which
  // ends a cell with an error rather than silently spending more.
  const concurrency = Math.max(1, Number(arg('concurrency', '3')))
  const cells: Array<{ variantId: CompactionVariantId; fixture: CompactionFixture }> = []
  for (const variantId of variantIds) {
    for (const fixture of fixtures) cells.push({ variantId, fixture })
  }

  // Cells are written as they land: a long paid run killed mid-way (timeout,
  // Ctrl-C) still leaves every finished cell on disk, and `--append` merges a
  // retry into it instead of paying for them again.
  const partialPath = join(REPO_ROOT, 'evals', 'compaction-results.json')
  const carried = flag('append') ? readCarriedResults(partialPath) : []
  // Spend already on disk before this slice started, so the total stays the
  // sum of the slices rather than the last slice's own bill.
  const carriedSpend = flag('append') ? previousSpend(partialPath) : 0
  const totalSpend = (): number => carriedSpend + spent.usd
  const persist = (): void => {
    mkdirSync(join(REPO_ROOT, 'evals'), { recursive: true })
    writeFileSync(
      partialPath,
      JSON.stringify(
        { date: new Date().toISOString(), model, summarizerModel, spendUsd: totalSpend(), results: [...carried, ...results.filter(Boolean)] },
        null,
        2,
      ),
      'utf8',
    )
  }

  // --resume drops cells already on disk: a run killed mid-slice (or a sandbox
  // timeout) is continued by re-invoking the same command, never re-billed.
  const already = new Set(carried.map((r) => `${r.variantId}|${r.fixtureId}`))
  const pending = flag('resume') ? cells.filter((c) => !already.has(`${c.variantId}|${c.fixture.id}`)) : cells
  if (flag('resume')) console.log(`Resuming: ${pending.length} of ${cells.length} cell(s) still to run`)
  // --report-only re-renders the report (and baseline) from cells already paid
  // for, so a slice-driven run can be summarised without spending anything.
  if (flag('report-only')) pending.length = 0

  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= pending.length) return
      if (spent.usd > maxUsd) return
      const cell = pending[index]!
      const result = await runFixtureVariant(cell.fixture, deps, { variant: COMPACTION_VARIANTS[cell.variantId] })
      results[index] = result
      persist()
      const note = result.error ? ` ERROR ${result.error}` : ''
      console.log(
        `  ${cell.variantId.padEnd(3)} ${cell.fixture.id.padEnd(28)} freed ${result.freedPct.toFixed(1).padStart(5)}%  ` +
          `recall ${(result.factRecall * 100).toFixed(0).padStart(3)}%  ` +
          `next ${result.nextActionMatch === null ? ' — ' : (result.nextActionMatch * 100).toFixed(0).padStart(3)}%` +
          `  dropped ${result.droppedResults}${note}`,
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()))

  const done = [...carried, ...results.filter(Boolean)]
  if (spent.usd > maxUsd) {
    console.warn(`Stopped at $${spent.usd.toFixed(4)} (limit $${maxUsd}); remaining cells skipped.`)
  }

  // --append merges this slice into the previous run's results, so a 30-fixture
  // x 6-variant eval can be paid for in pieces without losing the earlier ones.
  const resultsPath = join(REPO_ROOT, 'evals', 'compaction-results.json')
  let merged = done
  if (flag('append')) {
    const keyed = new Map<string, FixtureVariantResult>()
    for (const r of [...carried, ...done]) keyed.set(`${r.variantId}|${r.fixtureId}`, r)
    merged = [...keyed.values()]
  }

  // Compare on the fixtures every variant graded: partial coverage from a
  // sliced run must not be averaged as if each variant saw the same sessions.
  const gradedBy = variantIds.filter((id) => merged.some((r) => r.variantId === id))
  const shared = comparableFixtures(merged, gradedBy)
  const sharedSet = new Set(shared)
  const scoped = shared.length > 0 ? merged.filter((r) => sharedSet.has(r.fixtureId)) : merged

  const summaries = variantIds
    .map((id) => summariseVariant(id, scoped.filter((r) => r.variantId === id)))
    .filter((s) => s.fixtures > 0)

  const baselineSummary = summaries.find((s) => s.variantId === 'A') ?? null
  let recordedBaseline = null
  if (existsSync(BASELINE_PATH)) {
    try {
      recordedBaseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    } catch {
      recordedBaseline = null
    }
  }
  const compareTo = recordedBaseline?.baseline ?? baselineSummary
  // Only what this run executed is evidence. A track left off the command line
  // reads as `not run`, which fails the gate — never as a pass inherited from a
  // baseline recorded on some earlier run.
  const requiredTracks = parseRequiredTracks(arg('tracks'))

  const report = renderCompactionReport({
    fixtures: new Set(scoped.map((r) => r.fixtureId)).size,
    model,
    summarizerModel,
    variants: summaries,
    results: scoped,
    baseline: compareTo,
    requiredTracks,
    excludedCells: merged.length - scoped.length,
    spendUsd: totalSpend(),
  })

  mkdirSync(join(REPO_ROOT, 'evals'), { recursive: true })
  writeFileSync(REPORT_PATH, `${report}\n`, 'utf8')
  mkdirSync(join(import.meta.dir), { recursive: true })
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        model,
        summarizerModel,
        spendUsd: totalSpend(),
        requiredTracks,
        summaries,
        results: merged,
      },
      null,
      2,
    ),
    'utf8',
  )

  console.log('')
  console.log(report)
  console.log('')
  console.log(`Spend: $${totalSpend().toFixed(4)}`)
  console.log(`Report: ${REPORT_PATH}`)

  if (flag('write-baseline') && baselineSummary) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(buildBaseline({ model, summarizerModel, fixtures: fixtures.length, requiredTracks }, baselineSummary, summaries), null, 2)}\n`,
      'utf8',
    )
    console.log(`Baseline recorded: ${BASELINE_PATH}`)
  }

  // A gate failure is a failed run *only* when asked to gate, so the first
  // baseline-recording run does not fail its own CI.
  if (flag('gate') && compareTo) {
    const verdicts = summaries
      .filter((s) => s.variantId !== compareTo.variantId)
      .map((s) => evaluateVariantGate({ summary: s, baseline: compareTo, requiredTracks }))
    if (verdicts.every((v) => !v.ok)) {
      console.error('Gate: no variant is eligible to become the default.')
      process.exit(2)
    }
  }
}

if (import.meta.main) {
  await main()
}
