// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Read a merged lcov.info and emit a coverage-gap report:
 *
 *   1. Per-file table (lines / functions / branches %, uncovered line count).
 *   2. Top-N files by uncovered-line count.
 *   3. Branch-coverage hotspots: files where branch% < 70 even though
 *      lines% > 90 (i.e. the body is reached but the conditionals aren't
 *      exercised).
 *   4. Files at 0% — never touched by any test.
 *
 * Drives the per-wave kill-list for the apps/api → 100% coverage plan
 * (.shogo/plans/appsapi-to-100-coverage_*.plan.md). Each later wave reads
 * the JSON output, filters by directory, and picks targets in order.
 *
 * Usage:
 *   bun run scripts/coverage-gap-report.ts <lcov.info> [--json out.json]
 *     [--filter <substring>] [--top N]
 *
 * Examples:
 *   # Print table for apps/api lcov, top 25 uncovered files
 *   bun run scripts/coverage-gap-report.ts apps/api/coverage/lcov.info --top 25
 *
 *   # JSON output for downstream tooling, filtered to lib/
 *   bun run scripts/coverage-gap-report.ts apps/api/coverage/lcov.info \
 *     --filter src/lib/ --json coverage/gaps-apps-api-lib.json
 *
 * Reads stdin if the input path is `-`.
 */

import { readFileSync, writeFileSync } from 'fs'

interface FileCoverage {
  file: string
  linesFound: number
  linesHit: number
  funcsFound: number
  funcsHit: number
  branchesFound: number
  branchesHit: number
}

interface Report {
  generatedAt: string
  source: string
  totals: {
    files: number
    linesFound: number
    linesHit: number
    funcsFound: number
    funcsHit: number
    branchesFound: number
    branchesHit: number
    linePct: number
    funcPct: number
    branchPct: number
  }
  files: Array<
    FileCoverage & {
      linePct: number
      funcPct: number
      branchPct: number
      uncoveredLines: number
    }
  >
  topUncovered: Array<{ file: string; uncoveredLines: number; linePct: number }>
  branchHotspots: Array<{ file: string; linePct: number; branchPct: number }>
  zeroPercent: string[]
}

function parseLcov(content: string): FileCoverage[] {
  const records: FileCoverage[] = []
  let current: FileCoverage | null = null

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('SF:')) {
      current = {
        file: line.slice(3),
        linesFound: 0,
        linesHit: 0,
        funcsFound: 0,
        funcsHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      }
      continue
    }

    if (!current) continue

    if (line.startsWith('LF:')) current.linesFound = Number(line.slice(3))
    else if (line.startsWith('LH:')) current.linesHit = Number(line.slice(3))
    else if (line.startsWith('FNF:')) current.funcsFound = Number(line.slice(4))
    else if (line.startsWith('FNH:')) current.funcsHit = Number(line.slice(4))
    else if (line.startsWith('BRF:')) current.branchesFound = Number(line.slice(4))
    else if (line.startsWith('BRH:')) current.branchesHit = Number(line.slice(4))
    else if (line === 'end_of_record') {
      records.push(current)
      current = null
    }
  }

  return records
}

function pct(hit: number, found: number): number {
  if (found === 0) return 100
  return (hit / found) * 100
}

function buildReport(records: FileCoverage[], source: string): Report {
  const totals = records.reduce(
    (acc, r) => {
      acc.linesFound += r.linesFound
      acc.linesHit += r.linesHit
      acc.funcsFound += r.funcsFound
      acc.funcsHit += r.funcsHit
      acc.branchesFound += r.branchesFound
      acc.branchesHit += r.branchesHit
      return acc
    },
    { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0, branchesFound: 0, branchesHit: 0 },
  )

  const files = records
    .map((r) => {
      const linePct = pct(r.linesHit, r.linesFound)
      const funcPct = pct(r.funcsHit, r.funcsFound)
      const branchPct = pct(r.branchesHit, r.branchesFound)
      return {
        ...r,
        linePct,
        funcPct,
        branchPct,
        uncoveredLines: r.linesFound - r.linesHit,
      }
    })
    .sort((a, b) => a.file.localeCompare(b.file))

  const topUncovered = [...files]
    .filter((f) => f.uncoveredLines > 0)
    .sort((a, b) => b.uncoveredLines - a.uncoveredLines)
    .slice(0, 50)
    .map((f) => ({ file: f.file, uncoveredLines: f.uncoveredLines, linePct: f.linePct }))

  const branchHotspots = files
    .filter((f) => f.branchesFound > 0 && f.linePct >= 90 && f.branchPct < 70)
    .sort((a, b) => a.branchPct - b.branchPct)
    .map((f) => ({ file: f.file, linePct: f.linePct, branchPct: f.branchPct }))

  const zeroPercent = files
    .filter((f) => f.linesFound > 0 && f.linesHit === 0)
    .map((f) => f.file)

  return {
    generatedAt: new Date().toISOString(),
    source,
    totals: {
      files: files.length,
      linesFound: totals.linesFound,
      linesHit: totals.linesHit,
      funcsFound: totals.funcsFound,
      funcsHit: totals.funcsHit,
      branchesFound: totals.branchesFound,
      branchesHit: totals.branchesHit,
      linePct: pct(totals.linesHit, totals.linesFound),
      funcPct: pct(totals.funcsHit, totals.funcsFound),
      branchPct: pct(totals.branchesHit, totals.branchesFound),
    },
    files,
    topUncovered,
    branchHotspots,
    zeroPercent,
  }
}

function fmt(n: number): string {
  return n.toFixed(2).padStart(6) + '%'
}

function shortPath(p: string, max = 60): string {
  if (p.length <= max) return p
  return '…' + p.slice(p.length - max + 1)
}

function printReport(r: Report, top: number, filter: string | null): void {
  const filtered = filter ? r.files.filter((f) => f.file.includes(filter)) : r.files
  const log = (s = ''): void => process.stdout.write(s + '\n')

  log()
  log(`Coverage gap report — ${r.source}`)
  log(`Generated ${r.generatedAt}`)
  if (filter) log(`Filter: ${filter}`)
  log('─'.repeat(96))
  log(
    `Totals: ${filtered.length} files · ` +
      `lines ${fmt(r.totals.linePct)} (${r.totals.linesHit}/${r.totals.linesFound}) · ` +
      `funcs ${fmt(r.totals.funcPct)} (${r.totals.funcsHit}/${r.totals.funcsFound}) · ` +
      `branches ${fmt(r.totals.branchPct)} (${r.totals.branchesHit}/${r.totals.branchesFound})`,
  )
  log('─'.repeat(96))
  log(
    'FILE'.padEnd(64) +
      'LINES'.padStart(8) +
      'FUNCS'.padStart(8) +
      'BRANCH'.padStart(8) +
      'GAP'.padStart(6),
  )
  log('─'.repeat(96))

  const sorted = [...filtered].sort((a, b) => a.linePct - b.linePct)
  for (const f of sorted) {
    log(
      shortPath(f.file, 62).padEnd(64) +
        fmt(f.linePct) +
        ' ' +
        fmt(f.funcPct) +
        ' ' +
        fmt(f.branchPct) +
        ' ' +
        String(f.uncoveredLines).padStart(5),
    )
  }

  log()
  log(`Top ${Math.min(top, r.topUncovered.length)} files by uncovered lines:`)
  for (const f of r.topUncovered.slice(0, top)) {
    log(`  ${String(f.uncoveredLines).padStart(5)}  ${fmt(f.linePct)}  ${shortPath(f.file, 80)}`)
  }

  if (r.branchHotspots.length > 0) {
    log()
    log(`Branch hotspots (lines >= 90%, branches < 70%):`)
    for (const f of r.branchHotspots.slice(0, top)) {
      log(`  lines ${fmt(f.linePct)}  branch ${fmt(f.branchPct)}  ${shortPath(f.file, 70)}`)
    }
  }

  if (r.zeroPercent.length > 0) {
    log()
    log(`Files at 0% (${r.zeroPercent.length}):`)
    for (const f of r.zeroPercent.slice(0, top)) {
      log(`  ${shortPath(f, 90)}`)
    }
    if (r.zeroPercent.length > top) {
      log(`  … and ${r.zeroPercent.length - top} more`)
    }
  }

  log()
}

function main(): void {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.error(
      'usage: coverage-gap-report.ts <lcov.info|-> [--json out.json] [--filter substr] [--top N]',
    )
    process.exit(2)
  }

  let lcovPath = ''
  let jsonOut: string | null = null
  let filter: string | null = null
  let top = 20

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') jsonOut = argv[++i] ?? null
    else if (a === '--filter') filter = argv[++i] ?? null
    else if (a === '--top') top = Number(argv[++i] ?? '20') || 20
    else if (!lcovPath) lcovPath = a
  }

  if (!lcovPath) {
    console.error('missing lcov path')
    process.exit(2)
  }

  const content = lcovPath === '-' ? readFileSync(0, 'utf8') : readFileSync(lcovPath, 'utf8')
  const records = parseLcov(content)
  if (records.length === 0) {
    console.error(`no SF records found in ${lcovPath}`)
    process.exit(1)
  }

  const report = buildReport(records, lcovPath)

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(report, null, 2))
    console.error(`wrote ${jsonOut} (${report.files.length} files)`)
  }

  printReport(report, top, filter)
}

main()
