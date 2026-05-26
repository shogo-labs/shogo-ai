// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Post-process a Bun-emitted `lcov.info` to drop coverage records that
 * land on pure comment / pure whitespace lines.
 *
 * Why: Bun's V8-based coverage reporter emits `DA:<line>,0` for every
 * line in a source file that the test run did not execute — INCLUDING
 * lines that are pure `//` comments, pure block comments, JSDoc
 * banners, and blank lines. Across the agent-runtime package this
 * inflates the "uncovered lines" count by ~40% (5,006 of 12,376 raw
 * "uncovered" lines are non-executable). Single files can be ~89%
 * inflated (workspace-defaults.ts: 194 of 219 reported gaps are
 * documentation comments).
 *
 * That artifact is the single largest reason the README's backend
 * coverage badge under-reports reality — and why per-file uncovered
 * counts in `coverage/baselines/*.gaps.json` are wildly higher than
 * the code actually warrants.
 *
 * Usage:
 *   bun run scripts/coverage-strip-comments.ts <lcov.info> [--write] [--source-root <dir>]
 *
 * Without `--write` the cleaned lcov is printed to stdout and the
 * before/after totals are printed to stderr. With `--write` the input
 * file is rewritten in-place and a sidecar `<lcov.info>.raw` is left
 * behind with the original bytes for diffing.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs'
import { resolve, isAbsolute } from 'path'

interface ClassifiedLine {
  n: number
  executable: boolean
}

/**
 * Walk a source file and decide for every 1-based line number whether
 * it contains anything that V8 could conceivably mark hit or miss.
 * Blanks, pure single-line comments, and lines fully inside a block
 * comment are non-executable; everything else is executable.
 */
export function classifySource(src: string): ClassifiedLine[] {
  const lines = src.split('\n')
  const out: ClassifiedLine[] = []
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]
    let hasExec = false
    let j = 0
    while (j < s.length) {
      if (inBlock) {
        const end = s.indexOf('*/', j)
        if (end === -1) { j = s.length } else { j = end + 2; inBlock = false }
        continue
      }
      const ch = s[j]
      const next = s[j + 1]
      if (ch === '/' && next === '/') break
      if (ch === '/' && next === '*') { inBlock = true; j += 2; continue }
      if (ch === '"' || ch === "'" || ch === '`') {
        hasExec = true
        const quote = ch
        j++
        while (j < s.length) {
          if (s[j] === '\\') { j += 2; continue }
          if (s[j] === quote) { j++; break }
          j++
        }
        continue
      }
      if (!/\s/.test(ch)) hasExec = true
      j++
    }
    out.push({ n: i + 1, executable: hasExec })
  }
  return out
}

interface LcovStats {
  files: number
  lines: { total: number; hit: number }
  funcs: { total: number; hit: number }
  branches: { total: number; hit: number }
  scrubbedLineEntries: number
}

function emptyStats(): LcovStats {
  return {
    files: 0,
    lines: { total: 0, hit: 0 },
    funcs: { total: 0, hit: 0 },
    branches: { total: 0, hit: 0 },
    scrubbedLineEntries: 0,
  }
}

function recordStats(stats: LcovStats, block: string): void {
  stats.files++
  const grab = (label: string) => {
    const m = block.match(new RegExp(`^${label}:(\\d+)`, 'm'))
    return m ? parseInt(m[1], 10) : 0
  }
  stats.lines.total += grab('LF')
  stats.lines.hit += grab('LH')
  stats.funcs.total += grab('FNF')
  stats.funcs.hit += grab('FNH')
  stats.branches.total += grab('BRF')
  stats.branches.hit += grab('BRH')
}

function rewriteBlock(block: string, sourceRoot: string): { block: string; scrubbed: number } {
  const sfMatch = block.match(/^SF:(.+)$/m)
  if (!sfMatch) return { block, scrubbed: 0 }
  const srcPath = sfMatch[1].trim()
  const abs = isAbsolute(srcPath) ? srcPath : resolve(sourceRoot, srcPath)
  if (!existsSync(abs)) return { block, scrubbed: 0 }
  let src: string
  try { src = readFileSync(abs, 'utf-8') } catch { return { block, scrubbed: 0 } }

  const classified = classifySource(src)
  const nonExec = new Set<number>()
  for (const { n, executable } of classified) if (!executable) nonExec.add(n)
  if (nonExec.size === 0) return { block, scrubbed: 0 }

  const lines = block.split('\n')
  const kept: string[] = []
  let scrubbed = 0
  let lf = 0
  let lh = 0
  let brf = 0
  let brh = 0
  for (const line of lines) {
    if (line.startsWith('DA:')) {
      const [linePart, hitPart] = line.slice(3).split(',')
      const lineNo = parseInt(linePart, 10)
      const hits = parseInt(hitPart, 10) || 0
      if (nonExec.has(lineNo) && hits === 0) { scrubbed++; continue }
      lf++
      if (hits > 0) lh++
      kept.push(line)
      continue
    }
    if (line.startsWith('BRDA:')) {
      const segs = line.slice(5).split(',')
      const lineNo = parseInt(segs[0], 10)
      if (nonExec.has(lineNo)) continue
      brf++
      const taken = segs[3]
      if (taken && taken !== '-' && parseInt(taken, 10) > 0) brh++
      kept.push(line)
      continue
    }
    if (line.startsWith('LF:') || line.startsWith('LH:') || line.startsWith('BRF:') || line.startsWith('BRH:')) continue
    kept.push(line)
  }
  const eorIdx = kept.findIndex((l) => l === 'end_of_record')
  const insertAt = eorIdx === -1 ? kept.length : eorIdx
  kept.splice(insertAt, 0, `LF:${lf}`, `LH:${lh}`, `BRF:${brf}`, `BRH:${brh}`)
  return { block: kept.join('\n'), scrubbed }
}

export function stripCommentLines(lcov: string, sourceRoot: string): { lcov: string; before: LcovStats; after: LcovStats } {
  const before = emptyStats()
  const after = emptyStats()
  const blocks = lcov.split(/end_of_record\n?/)
  const out: string[] = []
  for (const blk of blocks) {
    if (!blk.includes('SF:')) {
      if (blk.trim()) out.push(blk)
      continue
    }
    const block = blk.endsWith('\n') ? blk + 'end_of_record\n' : blk + '\nend_of_record\n'
    recordStats(before, block)
    const { block: rewritten, scrubbed } = rewriteBlock(block, sourceRoot)
    recordStats(after, rewritten)
    after.scrubbedLineEntries += scrubbed
    out.push(rewritten)
  }
  return { lcov: out.join(''), before, after }
}

function fmtPct(hit: number, total: number): string {
  if (total === 0) return ' n/a '
  return `${(100 * hit / total).toFixed(2)}%`
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const positional = argv.filter((a) => !a.startsWith('--'))
  const lcovPath = positional[0]
  if (!lcovPath) {
    console.error('usage: coverage-strip-comments.ts <lcov.info> [--write] [--source-root <dir>]')
    process.exit(2)
  }
  const rootIdx = argv.indexOf('--source-root')
  const sourceRoot = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd()
  const lcov = readFileSync(lcovPath, 'utf-8')
  const { lcov: cleaned, before, after } = stripCommentLines(lcov, sourceRoot)
  const report = (label: string, s: LcovStats) =>
    `[${label}] files=${s.files} lines=${s.lines.hit}/${s.lines.total} (${fmtPct(s.lines.hit, s.lines.total)}) ` +
    `funcs=${s.funcs.hit}/${s.funcs.total} (${fmtPct(s.funcs.hit, s.funcs.total)}) ` +
    `branches=${s.branches.hit}/${s.branches.total} (${fmtPct(s.branches.hit, s.branches.total)})`
  console.error(report('raw    ', before))
  console.error(report('cleaned', after))
  console.error(`[scrubbed] ${after.scrubbedLineEntries} comment/whitespace DA: entries dropped`)
  if (write) {
    const backup = `${lcovPath}.raw`
    if (!existsSync(backup)) copyFileSync(lcovPath, backup)
    writeFileSync(lcovPath, cleaned)
    console.error(`[wrote] ${lcovPath} (backup at ${backup})`)
  } else {
    process.stdout.write(cleaned)
  }
}

if (import.meta.main) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
