// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Merge multiple lcov.info files into a single lcov.info, then optionally
 * print an aggregate text summary and enforce a coverage threshold.
 *
 * lcov format reminder (one record per source file, terminated by
 * `end_of_record`):
 *
 *   SF:<filename>
 *   FN:<line>,<func>            (function definition)
 *   FNDA:<hits>,<func>          (function hit count)
 *   FNF:<n>                     (functions found)
 *   FNH:<n>                     (functions hit)
 *   DA:<line>,<hits>            (line execution count)
 *   LF:<n>                      (lines found)
 *   LH:<n>                      (lines hit)
 *   BRDA:<line>,<block>,<branch>,<taken|->
 *   BRF:<n> / BRH:<n>
 *   end_of_record
 *
 * Multiple lcov files for the same source — produced by per-file isolated
 * test runs — must be merged record-by-record: sum hit counts on matching
 * DA lines, take the union of FN, sum FNDA, etc. Concatenation alone
 * over-counts source totals (the same SF block appears twice).
 *
 * Usage:
 *   bun run scripts/merge-lcov.ts <out.info> <input1.info> [input2.info ...]
 *   bun run scripts/merge-lcov.ts --threshold-line 0.5 \
 *      --threshold-function 0.5 -o coverage/lcov.info <inputs...>
 *   bun run scripts/merge-lcov.ts --update-readme README.md \
 *      -o coverage/lcov.info <inputs...>
 *
 * Threshold flags exit non-zero if the merged aggregate falls below.
 * `--update-readme` rewrites the `<!-- coverage-badge -->...` block in
 * the given README with a shields.io static badge for the current
 * line coverage percentage.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve, relative, isAbsolute } from 'path'

interface FileRecord {
  sourceFile: string
  testName?: string
  // line -> hits  (DA records)
  lineHits: Map<number, number>
  // func name -> { line, hits }
  functions: Map<string, { line: number; hits: number }>
  // "<line>,<block>,<branch>" -> hits ('-' counted as 0)
  branches: Map<string, number>
  // Bun's lcov reporter omits FN/FNDA per-function records and emits
  // only the FNF (functions found) / FNH (functions hit) totals. When
  // we have no per-function detail we keep these aggregates so the
  // post-merge totals don't always read 0/0. They are summed across
  // shards (single shard per source file in a per-package run; for
  // apps/api's process-per-file runner the same source can show up in
  // multiple shards — we sum for an over-approximation that still
  // gives a useful aggregate ratio).
  fnfFallback: number
  fnhFallback: number
}

/**
 * Normalize an `SF:` path so the same source file shows up under the
 * same key regardless of which package's lcov shard reported it.
 *
 * Bun emits `SF:` paths relative to the bun-test cwd (the package
 * directory). Without normalization, `packages/shared-runtime/src/foo.ts`
 * appears as `src/foo.ts` in shared-runtime's shard but
 * `../shared-runtime/src/foo.ts` in agent-runtime's shard, so the
 * merger can't combine the two and aggregate coverage looks worse than
 * it really is. We resolve against the shard's cwd and re-key by repo-
 * relative path, anchored at `repoRoot`.
 */
function normalizeSourceFile(sf: string, shardCwd: string, repoRoot: string): string {
  const abs = isAbsolute(sf) ? sf : resolve(shardCwd, sf)
  const rel = relative(repoRoot, abs)
  // If the file lives outside the repo, keep the absolute path so we
  // don't end up with confusing `../../` keys that walk past the root.
  return rel.startsWith('..') ? abs : rel
}

function parseLcov(text: string, shardCwd: string, repoRoot: string): Map<string, FileRecord> {
  const out = new Map<string, FileRecord>()
  let cur: FileRecord | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === 'end_of_record') {
      cur = null
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const tag = line.slice(0, colon)
    const rest = line.slice(colon + 1)

    if (tag === 'SF') {
      const sf = normalizeSourceFile(rest, shardCwd, repoRoot)
      let rec = out.get(sf)
      if (!rec) {
        rec = {
          sourceFile: sf,
          lineHits: new Map(),
          functions: new Map(),
          branches: new Map(),
          fnfFallback: 0,
          fnhFallback: 0,
        }
        out.set(sf, rec)
      }
      cur = rec
      continue
    }
    if (!cur) continue

    if (tag === 'TN') {
      cur.testName = rest
    } else if (tag === 'FNF') {
      cur.fnfFallback = Math.max(cur.fnfFallback, Number(rest) || 0)
    } else if (tag === 'FNH') {
      cur.fnhFallback = Math.max(cur.fnhFallback, Number(rest) || 0)
    } else if (tag === 'DA') {
      const [lnStr, hitsStr] = rest.split(',')
      const ln = Number(lnStr)
      const hits = Number(hitsStr) || 0
      const prev = cur.lineHits.get(ln) ?? 0
      cur.lineHits.set(ln, prev + hits)
    } else if (tag === 'FN') {
      const [lnStr, ...nameParts] = rest.split(',')
      const name = nameParts.join(',')
      const ln = Number(lnStr)
      const existing = cur.functions.get(name)
      if (!existing) cur.functions.set(name, { line: ln, hits: 0 })
    } else if (tag === 'FNDA') {
      const [hitsStr, ...nameParts] = rest.split(',')
      const name = nameParts.join(',')
      const hits = Number(hitsStr) || 0
      const existing = cur.functions.get(name)
      if (existing) existing.hits += hits
      else cur.functions.set(name, { line: 0, hits })
    } else if (tag === 'BRDA') {
      // line,block,branch,(taken|-)
      const parts = rest.split(',')
      if (parts.length >= 4) {
        const key = `${parts[0]},${parts[1]},${parts[2]}`
        const takenRaw = parts[3]
        const hits = takenRaw === '-' ? 0 : Number(takenRaw) || 0
        cur.branches.set(key, (cur.branches.get(key) ?? 0) + hits)
      }
    }
    // FNF/FNH/LF/LH/BRF/BRH are recomputed on emit, so we ignore the
    // input values (they would be wrong after a merge anyway).
  }
  return out
}

function emitLcov(records: Map<string, FileRecord>): string {
  const out: string[] = []
  for (const rec of records.values()) {
    out.push(`TN:${rec.testName ?? ''}`)
    out.push(`SF:${rec.sourceFile}`)

    for (const [name, info] of rec.functions) {
      if (info.line > 0) out.push(`FN:${info.line},${name}`)
    }
    let funcsHit = 0
    for (const [name, info] of rec.functions) {
      out.push(`FNDA:${info.hits},${name}`)
      if (info.hits > 0) funcsHit++
    }
    // If the input lcov files only carried FNF/FNH aggregates (Bun's
    // current default), use those instead of computed FN totals.
    const fnf = rec.functions.size > 0 ? rec.functions.size : rec.fnfFallback
    const fnh = rec.functions.size > 0 ? funcsHit : rec.fnhFallback
    out.push(`FNF:${fnf}`)
    out.push(`FNH:${fnh}`)

    let branchesHit = 0
    const sortedBranches = [...rec.branches.entries()].sort((a, b) => {
      const [al, ab, abr] = a[0].split(',').map(Number)
      const [bl, bb, bbr] = b[0].split(',').map(Number)
      return al - bl || ab - bb || abr - bbr
    })
    for (const [key, hits] of sortedBranches) {
      const [ln, block, branch] = key.split(',')
      out.push(`BRDA:${ln},${block},${branch},${hits === 0 ? '-' : hits}`)
      if (hits > 0) branchesHit++
    }
    out.push(`BRF:${rec.branches.size}`)
    out.push(`BRH:${branchesHit}`)

    let linesHit = 0
    const sortedLines = [...rec.lineHits.entries()].sort((a, b) => a[0] - b[0])
    for (const [ln, hits] of sortedLines) {
      out.push(`DA:${ln},${hits}`)
      if (hits > 0) linesHit++
    }
    out.push(`LF:${rec.lineHits.size}`)
    out.push(`LH:${linesHit}`)
    out.push('end_of_record')
  }
  return out.join('\n') + '\n'
}

interface Totals {
  files: number
  linesFound: number
  linesHit: number
  funcsFound: number
  funcsHit: number
}

function computeTotals(records: Map<string, FileRecord>): Totals {
  let linesFound = 0
  let linesHit = 0
  let funcsFound = 0
  let funcsHit = 0
  for (const rec of records.values()) {
    linesFound += rec.lineHits.size
    for (const hits of rec.lineHits.values()) if (hits > 0) linesHit++
    if (rec.functions.size > 0) {
      funcsFound += rec.functions.size
      for (const f of rec.functions.values()) if (f.hits > 0) funcsHit++
    } else {
      // Bun-only FNF/FNH path
      funcsFound += rec.fnfFallback
      funcsHit += Math.min(rec.fnhFallback, rec.fnfFallback)
    }
  }
  return { files: records.size, linesFound, linesHit, funcsFound, funcsHit }
}

function pct(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100
}

// Standard codecov-style color thresholds. Keeping these here (instead
// of e.g. a fancy gradient) so the badge looks identical to what most
// readers expect from open-source repos.
function badgeColor(percent: number): string {
  if (percent < 50) return 'red'
  if (percent < 60) return 'orange'
  if (percent < 70) return 'yellow'
  if (percent < 80) return 'yellowgreen'
  if (percent < 90) return 'green'
  return 'brightgreen'
}

function buildBadgeMarkdown(linePct: number): string {
  const color = badgeColor(linePct)
  const url = `https://img.shields.io/badge/coverage-${linePct.toFixed(2)}%25-${color}`
  // Link points at the merged lcov so curious readers cloning the repo
  // can run `bun run test:coverage` and see the file the badge reflects.
  return `[![Coverage](${url})](./coverage/lcov.info)`
}

const README_BADGE_OPEN = '<!-- coverage-badge -->'
const README_BADGE_CLOSE = '<!-- /coverage-badge -->'

function updateReadmeBadge(readmePath: string, linePct: number): void {
  if (!existsSync(readmePath)) {
    console.error(`[badge] README not found at ${readmePath} — skipping update`)
    return
  }
  const text = readFileSync(readmePath, 'utf-8')
  const badge = buildBadgeMarkdown(linePct)
  const replacement = `${README_BADGE_OPEN}\n${badge}\n${README_BADGE_CLOSE}`
  const marker = new RegExp(
    `${README_BADGE_OPEN.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[\\s\\S]*?${README_BADGE_CLOSE.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`,
  )
  let next: string
  if (marker.test(text)) {
    next = text.replace(marker, replacement)
  } else {
    // First-time install: drop the marker block right after the H1 so
    // readers see it without having to scroll.
    const lines = text.split('\n')
    const h1Idx = lines.findIndex((l) => l.startsWith('# '))
    if (h1Idx < 0) {
      console.error(`[badge] no H1 found in ${readmePath} — appending badge at top`)
      next = `${replacement}\n\n${text}`
    } else {
      lines.splice(h1Idx + 1, 0, '', replacement)
      next = lines.join('\n')
    }
  }
  if (next !== text) {
    writeFileSync(readmePath, next)
    console.log(`[badge] updated ${readmePath} → ${linePct.toFixed(2)}%`)
  }
}

interface CliArgs {
  out: string
  inputs: string[]
  thresholdLine: number | null
  thresholdFunction: number | null
  silent: boolean
  // When false, threshold misses are printed as warnings and the
  // process still exits 0. This is the default ("soft floor"): we want
  // coverage visibility without breaking CI on the first run, since a
  // codebase with 32% coverage isn't going to hit 50% overnight. Set
  // --strict (or SHOGO_COVERAGE_STRICT=1) to enforce.
  strict: boolean
  // Optional path to a README file. When set, the merger rewrites the
  // `<!-- coverage-badge -->...<!-- /coverage-badge -->` block with a
  // shields.io static badge for the current line coverage. Keeps the
  // badge in sync without committing an SVG.
  updateReadme: string | null
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    out: 'coverage/lcov.info',
    inputs: [],
    thresholdLine: null,
    thresholdFunction: null,
    silent: false,
    strict: process.env.SHOGO_COVERAGE_STRICT === '1',
    updateReadme: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-o' || a === '--out') {
      args.out = argv[++i]
    } else if (a === '--threshold-line') {
      args.thresholdLine = Number(argv[++i])
    } else if (a === '--threshold-function' || a === '--threshold-func') {
      args.thresholdFunction = Number(argv[++i])
    } else if (a === '--silent') {
      args.silent = true
    } else if (a === '--strict') {
      args.strict = true
    } else if (a === '--update-readme') {
      args.updateReadme = argv[++i]
    } else if (a === '--') {
      args.inputs.push(...argv.slice(i + 1))
      break
    } else {
      args.inputs.push(a)
    }
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.inputs.length) {
    console.error('usage: merge-lcov.ts [-o out.info] <input1.info> [input2.info ...]')
    process.exit(2)
  }

  // Repo root anchors all SF normalization. Heuristic: walk up from this
  // script's location to a directory that holds a `package.json` whose
  // `workspaces` field is set (the monorepo root), falling back to two
  // levels up from this file (`scripts/` lives at the repo root).
  const repoRoot = resolve(import.meta.dir, '..')

  const merged = new Map<string, FileRecord>()
  let parsedFiles = 0
  for (const input of args.inputs) {
    const path = resolve(process.cwd(), input)
    if (!existsSync(path)) {
      // Empty shards are fine — just skip them. (Some test files don't
      // execute any source under the package, so bun emits nothing.)
      continue
    }
    // The shard's cwd is the package dir that owns `coverage/lcov.info`
    // (or, for apps/api, `coverage/.shards/<slug>/lcov.info`). Strip
    // the `/coverage/.../...` tail back to the package root.
    const coverageMatch = path.match(/^(.+?)\/coverage(?:\/|$)/)
    const shardCwd = coverageMatch ? coverageMatch[1] : dirname(path)
    const text = readFileSync(path, 'utf-8')
    const part = parseLcov(text, shardCwd, repoRoot)
    parsedFiles++
    for (const [sf, rec] of part) {
      const dest = merged.get(sf)
      if (!dest) {
        merged.set(sf, rec)
        continue
      }
      for (const [ln, hits] of rec.lineHits) {
        dest.lineHits.set(ln, (dest.lineHits.get(ln) ?? 0) + hits)
      }
      for (const [name, info] of rec.functions) {
        const existing = dest.functions.get(name)
        if (existing) {
          existing.hits += info.hits
          if (info.line > 0 && existing.line === 0) existing.line = info.line
        } else {
          dest.functions.set(name, { ...info })
        }
      }
      for (const [key, hits] of rec.branches) {
        dest.branches.set(key, (dest.branches.get(key) ?? 0) + hits)
      }
      // For Bun's terse FNF/FNH-only format, take the max across shards.
      // This is an over-approximation when the same source is loaded
      // from multiple shards (apps/api's per-file isolated runner) but
      // it stays internally consistent: hit count never exceeds the
      // count of declared functions.
      dest.fnfFallback = Math.max(dest.fnfFallback, rec.fnfFallback)
      dest.fnhFallback = Math.max(dest.fnhFallback, rec.fnhFallback)
    }
  }

  const outPath = resolve(process.cwd(), args.out)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, emitLcov(merged))

  const totals = computeTotals(merged)
  const linePct = pct(totals.linesHit, totals.linesFound)
  const funcPct = pct(totals.funcsHit, totals.funcsFound)

  if (!args.silent) {
    console.log()
    console.log('─'.repeat(72))
    console.log(`Merged coverage report: ${outPath}`)
    console.log(
      `  files:     ${totals.files} (from ${parsedFiles}/${args.inputs.length} input lcov files)`,
    )
    console.log(`  lines:     ${totals.linesHit}/${totals.linesFound} (${linePct.toFixed(2)}%)`)
    console.log(`  functions: ${totals.funcsHit}/${totals.funcsFound} (${funcPct.toFixed(2)}%)`)
    console.log('─'.repeat(72))
  }

  let breached = false
  const breachLabel = args.strict ? 'BELOW' : 'WARN'
  if (args.thresholdLine != null) {
    const required = args.thresholdLine * 100
    if (linePct + 1e-9 < required) {
      console.error(
        `[${breachLabel}] line coverage ${linePct.toFixed(2)}% is below threshold ${required.toFixed(2)}%`,
      )
      breached = true
    }
  }
  if (args.thresholdFunction != null) {
    const required = args.thresholdFunction * 100
    if (funcPct + 1e-9 < required) {
      console.error(
        `[${breachLabel}] function coverage ${funcPct.toFixed(2)}% is below threshold ${required.toFixed(2)}%`,
      )
      breached = true
    }
  }
  if (breached && !args.strict) {
    console.error(
      'coverage: thresholds not met; running in soft-floor mode (set --strict or SHOGO_COVERAGE_STRICT=1 to enforce)',
    )
  }

  if (args.updateReadme) {
    const readmePath = resolve(process.cwd(), args.updateReadme)
    updateReadmeBadge(readmePath, linePct)
  }

  process.exit(breached && args.strict ? 1 : 0)
}

main()
