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
 *
 * Special case: Bun sometimes emits paths that are *already* repo-
 * relative (e.g. `packages/shared-runtime/src/foo.ts`) even when the
 * shard cwd is `apps/api/`. Resolving those against the shard cwd
 * produces nonsense double-prefixed keys like
 * `apps/api/packages/shared-runtime/src/foo.ts`, which both inflates
 * the denominator (same file shows up under three keys) and splits the
 * coverage across them (the union of lines hit is lost). We detect the
 * already-repo-relative shape up front and pass it through unchanged.
 */
const REPO_RELATIVE_PREFIX_RE = /^(packages|apps|e2e|scripts|templates|infra|terraform|k8s)\//
export function normalizeSourceFile(sf: string, shardCwd: string, repoRoot: string): string {
  if (isAbsolute(sf)) {
    const rel = relative(repoRoot, sf)
    return rel.startsWith('..') ? sf : rel
  }
  if (REPO_RELATIVE_PREFIX_RE.test(sf)) {
    // Already keyed against the repo root — don't double-prefix it.
    return sf
  }
  const abs = resolve(shardCwd, sf)
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

/**
 * Map a repo-relative source path to the "package" key the JSON summary
 * groups by. Matches the buckets used in `scripts/run-all-tests.ts`'s
 * `TEST_PACKAGES` so PR checks can show per-package deltas without a
 * separate config. Anything not under `apps/<x>/` or `packages/<x>/`
 * lands under `other`.
 */
function packageKey(sf: string): string {
  const m = sf.match(/^(apps|packages)\/([^/]+)\//)
  if (!m) return 'other'
  return `${m[1]}/${m[2]}`
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

function packageSummary(records: Map<string, FileRecord>) {
  const t = computeTotals(records)
  return {
    files: t.files,
    linesFound: t.linesFound,
    linesHit: t.linesHit,
    linesPct: Number(pct(t.linesHit, t.linesFound).toFixed(2)),
    funcsFound: t.funcsFound,
    funcsHit: t.funcsHit,
    funcsPct: Number(pct(t.funcsHit, t.funcsFound).toFixed(2)),
  }
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

/**
 * Render a shields.io static badge for `linePct` line coverage.
 *
 * `label` controls both the human-facing badge text ("backend
 * coverage", "frontend coverage", or just "coverage" when omitted)
 * and the alt text. `lcovPath` controls the GitHub-relative link the
 * badge clicks through to. Splitting these two out lets a single
 * README carry distinct backend / frontend badges that point at
 * separate lcov shards in `coverage/`.
 */
function buildBadgeMarkdown(linePct: number, label: string, lcovPath: string): string {
  const color = badgeColor(linePct)
  // shields.io requires URL-encoding for spaces (label "backend
  // coverage" becomes "backend%20coverage"). Hyphens in the label
  // are themselves separators in the static-badge URL spec, so we
  // also escape any literal `-` to `--`.
  const labelEncoded = encodeURIComponent(label).replace(/-/g, '--')
  const url = `https://img.shields.io/badge/${labelEncoded}-${linePct.toFixed(2)}%25-${color}`
  const alt = label.charAt(0).toUpperCase() + label.slice(1)
  return `[![${alt}](${url})](./${lcovPath})`
}

const DEFAULT_BADGE_KEY = 'coverage-badge'

/**
 * Replace the marker block (or insert one after the H1 if missing)
 * in `readmePath` with a freshly-rendered badge for `linePct`.
 *
 * `key` selects the marker pair: e.g. `coverage-badge:backend`
 * matches `<!-- coverage-badge:backend -->...<!-- /coverage-badge:backend -->`.
 * The default `coverage-badge` key preserves the existing behaviour
 * (legacy single-badge READMEs keep updating without any change).
 *
 * `label` and `lcovPath` are forwarded to `buildBadgeMarkdown` so a
 * "backend" badge can render different text and link than a "frontend"
 * badge in the same README.
 */
function updateReadmeBadge(
  readmePath: string,
  linePct: number,
  opts: { key?: string; label?: string; lcovPath?: string } = {},
): void {
  if (!existsSync(readmePath)) {
    console.error(`[badge] README not found at ${readmePath} — skipping update`)
    return
  }
  const key = opts.key ?? DEFAULT_BADGE_KEY
  const label = opts.label ?? 'coverage'
  const lcovPath = opts.lcovPath ?? 'coverage/lcov.info'
  const open = `<!-- ${key} -->`
  const close = `<!-- /${key} -->`
  const text = readFileSync(readmePath, 'utf-8')
  const badge = buildBadgeMarkdown(linePct, label, lcovPath)
  const replacement = `${open}\n${badge}\n${close}`
  const escapeRe = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  const marker = new RegExp(`${escapeRe(open)}[\\s\\S]*?${escapeRe(close)}`)
  let next: string
  if (marker.test(text)) {
    next = text.replace(marker, replacement)
  } else {
    // First-time install: drop the marker block right after the H1 so
    // readers see it without having to scroll. When a sibling badge
    // (e.g. backend's `<!-- coverage-badge:backend -->`) is already
    // present, we splice the new one immediately after it so the
    // group renders as a single line in GitHub.
    const lines = text.split('\n')
    const siblingRe = new RegExp(`^<!-- /${escapeRe(DEFAULT_BADGE_KEY)}(:[^ ]+)? -->$`)
    const siblingIdx = lines.findIndex((l) => siblingRe.test(l.trim()))
    if (siblingIdx >= 0) {
      lines.splice(siblingIdx + 1, 0, replacement)
      next = lines.join('\n')
    } else {
      const h1Idx = lines.findIndex((l) => l.startsWith('# '))
      if (h1Idx < 0) {
        console.error(`[badge] no H1 found in ${readmePath} — appending badge at top`)
        next = `${replacement}\n\n${text}`
      } else {
        lines.splice(h1Idx + 1, 0, '', replacement)
        next = lines.join('\n')
      }
    }
  }
  if (next !== text) {
    writeFileSync(readmePath, next)
    console.log(`[badge] updated ${readmePath} (${key}) → ${linePct.toFixed(2)}%`)
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
  // Optional path to a README file. When set, the merger rewrites a
  // marker block (default `<!-- coverage-badge -->...<!-- /coverage-badge -->`)
  // with a shields.io static badge for the current line coverage.
  // Keeps the badge in sync without committing an SVG.
  updateReadme: string | null
  // Marker key for the badge block — `coverage-badge:backend` matches
  // `<!-- coverage-badge:backend -->...<!-- /coverage-badge:backend -->`.
  // Defaults to `coverage-badge` for backward compat with the
  // historical single-badge READMEs.
  badgeKey: string | null
  // Human-facing label rendered in the badge (e.g. "backend coverage").
  // Falls back to `"coverage"` so the legacy badge still reads
  // `coverage 58%` after upgrading.
  badgeLabel: string | null
  // Repo-relative link target for the badge — usually the lcov file
  // this run produced (`coverage/frontend-lcov.info` for the frontend
  // pass, `coverage/lcov.info` for the backend pass). Defaults to
  // `coverage/lcov.info` to match the historical layout.
  badgeLcovPath: string | null
  // Optional path to a JSON summary written alongside the merged lcov.
  // Emits per-package + aggregate totals so PR checks can comment
  // file-level / per-package deltas without re-parsing lcov.
  summaryJson: string | null
  // Per-package minimum line coverage floor. Each entry is parsed as
  // `<package>:<fraction>` where `<package>` matches the keys emitted
  // in `summary.json` (e.g. `apps/api`, `packages/agent-runtime`) and
  // `<fraction>` is a number in [0,1]. Multiple floors may be given by
  // passing `--per-package-floor` repeatedly. Floors are evaluated in
  // addition to (not in place of) the aggregate threshold; breaches are
  // reported with the same WARN/BELOW severity model used at the top.
  perPackageFloors: Array<{ pkg: string; line: number }>
  // When non-empty, only file records whose `packageKey()` matches one
  // of these entries are kept in the merged output, the per-package
  // summary, and the threshold/floor checks. Used by `run-all-tests.ts`
  // to produce separate backend / frontend roll-ups from the same set
  // of per-package lcov shards (Bun emits cross-package coverage when
  // e.g. `agent-runtime` tests transitively load `shared-runtime`
  // sources, so input-file partitioning isn't enough). Cross-package
  // shard contamination is filtered post-merge via `packageKey()`.
  // Repeatable via `--include-package <pkg>` (e.g. `apps/api`).
  includePackages: string[]
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
    badgeKey: null,
    badgeLabel: null,
    badgeLcovPath: null,
    summaryJson: null,
    perPackageFloors: [],
    includePackages: [],
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
    } else if (a === '--badge-key') {
      args.badgeKey = argv[++i] ?? null
    } else if (a === '--badge-label') {
      args.badgeLabel = argv[++i] ?? null
    } else if (a === '--badge-lcov-path') {
      args.badgeLcovPath = argv[++i] ?? null
    } else if (a === '--summary-json') {
      args.summaryJson = argv[++i]
    } else if (a === '--per-package-floor') {
      const raw = argv[++i] ?? ''
      const colon = raw.lastIndexOf(':')
      if (colon < 0) {
        console.error(`[merge-lcov] invalid --per-package-floor "${raw}" (expected <package>:<fraction>)`)
        process.exit(2)
      }
      const pkg = raw.slice(0, colon)
      const frac = Number(raw.slice(colon + 1))
      if (!Number.isFinite(frac) || frac < 0 || frac > 1) {
        console.error(`[merge-lcov] invalid --per-package-floor fraction "${raw}" (must be 0..1)`)
        process.exit(2)
      }
      args.perPackageFloors.push({ pkg, line: frac })
    } else if (a === '--include-package') {
      const pkg = argv[++i] ?? ''
      if (!pkg) {
        console.error('[merge-lcov] --include-package requires a value (e.g. "apps/api")')
        process.exit(2)
      }
      args.includePackages.push(pkg)
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

  // Apply --include-package filter (if any) BEFORE emitting the lcov
  // and computing totals. We filter at the merged-record level rather
  // than at the input-file level because Bun's per-package coverage
  // shards routinely include source files from sibling packages
  // (e.g. `agent-runtime`'s test loads `shared-runtime/src/foo.ts`,
  // which then shows up under SF:packages/shared-runtime/src/foo.ts in
  // agent-runtime's lcov). Filtering by `packageKey(sf)` is the only
  // way to cleanly separate backend vs frontend roll-ups from the same
  // pool of shards.
  let scoped: Map<string, FileRecord> = merged
  if (args.includePackages.length > 0) {
    const allow = new Set(args.includePackages)
    scoped = new Map()
    for (const [sf, rec] of merged) {
      if (allow.has(packageKey(sf))) scoped.set(sf, rec)
    }
  }

  const outPath = resolve(process.cwd(), args.out)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, emitLcov(scoped))

  const totals = computeTotals(scoped)
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

  // Compute per-package totals once. Used for both `--summary-json`
  // emission and `--per-package-floor` enforcement. Iterates `scoped`
  // (post `--include-package` filter) so summaries match the lcov
  // that's actually written and the floors that are actually enforced.
  const perPackage = new Map<string, Map<string, FileRecord>>()
  for (const [sf, rec] of scoped) {
    const key = packageKey(sf)
    let bucket = perPackage.get(key)
    if (!bucket) {
      bucket = new Map()
      perPackage.set(key, bucket)
    }
    bucket.set(sf, rec)
  }
  const packages: Record<string, ReturnType<typeof packageSummary>> = {}
  for (const [key, bucket] of [...perPackage.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    packages[key] = packageSummary(bucket)
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
  for (const floor of args.perPackageFloors) {
    const pkgSummary = packages[floor.pkg]
    if (!pkgSummary) {
      console.error(
        `[${breachLabel}] per-package floor "${floor.pkg}" matched no source files (typo, or package not yet tested)`,
      )
      breached = true
      continue
    }
    const required = floor.line * 100
    if (pkgSummary.linesPct + 1e-9 < required) {
      console.error(
        `[${breachLabel}] package "${floor.pkg}" line coverage ${pkgSummary.linesPct.toFixed(2)}% is below floor ${required.toFixed(2)}%`,
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
    updateReadmeBadge(readmePath, linePct, {
      key: args.badgeKey ?? undefined,
      label: args.badgeLabel ?? undefined,
      lcovPath: args.badgeLcovPath ?? undefined,
    })
  }

  if (args.summaryJson) {
    const summaryPath = resolve(process.cwd(), args.summaryJson)
    mkdirSync(dirname(summaryPath), { recursive: true })
    const summary = {
      generatedAt: new Date().toISOString(),
      aggregate: {
        files: totals.files,
        linesFound: totals.linesFound,
        linesHit: totals.linesHit,
        linesPct: Number(linePct.toFixed(2)),
        funcsFound: totals.funcsFound,
        funcsHit: totals.funcsHit,
        funcsPct: Number(funcPct.toFixed(2)),
      },
      packages,
    }
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n')
    if (!args.silent) {
      console.log(`Wrote per-package summary: ${summaryPath}`)
    }
  }

  process.exit(breached && args.strict ? 1 : 0)
}

// Only execute the CLI entrypoint when this file is run directly as a
// script. Importing it (e.g. from `scripts/__tests__/merge-lcov.test.ts`
// to exercise `normalizeSourceFile` in isolation) must not trigger an
// `process.exit(2)` for missing positional inputs.
if (import.meta.main) {
  main()
}
