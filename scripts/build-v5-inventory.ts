// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Build coverage/v5-inventory.json from a merged lcov.
 *
 * For every SF (source file) record in the merged lcov, emit:
 *   { package, file, LH, LF, FNH, FNF, linePct, funcPct, gapLH, gapFN, bucket }
 *
 * Buckets:
 *   A = linePct >= 99 && funcPct >= 99   (skip — already effectively 100%)
 *   B = linePct >= 85                    (small surgical adds)
 *   C = linePct >= 60                    (medium build)
 *   D = linePct < 60                     (greenfield)
 *   X = file path matches exclusion list (test files, generated, .d.ts, etc.)
 *
 * Output order: bucket asc, gapLH desc, file asc.
 *
 * Usage:
 *   bun run scripts/build-v5-inventory.ts /tmp/backend.lcov > coverage/v5-inventory.json
 */

import { readFileSync } from 'fs'

const lcovPath = process.argv[2]
if (!lcovPath) {
  console.error('usage: build-v5-inventory.ts <merged.lcov>')
  process.exit(1)
}

interface Entry {
  package: string
  file: string
  LH: number
  LF: number
  FNH: number
  FNF: number
  linePct: number
  funcPct: number
  gapLH: number
  gapFN: number
  bucket: 'A' | 'B' | 'C' | 'D' | 'X'
}

const EXCLUDE_PATTERNS = [
  /\/__tests__\//,
  /\.test\.ts$/,
  /\.test\.tsx$/,
  /\.spec\.ts$/,
  /\.d\.ts$/,
  /\/generated\//,
  /\/dist\//,
  /\/node_modules\//,
  // .shogo seed templates etc. — agent-runtime ships scaffolds it does not test
  /\/templates\//,
  // schema-codegen output
  /prisma\/runtime\//,
]

function packageFor(file: string): string {
  if (file.startsWith('apps/api/')) return 'apps/api'
  if (file.startsWith('packages/agent-runtime/')) return 'packages/agent-runtime'
  if (file.startsWith('packages/sdk/')) return 'packages/sdk'
  if (file.startsWith('packages/shared-runtime/')) return 'packages/shared-runtime'
  if (file.startsWith('packages/model-catalog/')) return 'packages/model-catalog'
  if (file.startsWith('scripts/')) return 'scripts'
  // catch-all for any future package
  const m = file.match(/^(apps\/[^/]+|packages\/[^/]+|scripts)/)
  return m ? m[1] : 'other'
}

function bucketFor(file: string, linePct: number, funcPct: number): Entry['bucket'] {
  for (const p of EXCLUDE_PATTERNS) if (p.test(file)) return 'X'
  if (linePct >= 99 && funcPct >= 99) return 'A'
  if (linePct >= 85) return 'B'
  if (linePct >= 60) return 'C'
  return 'D'
}

const raw = readFileSync(lcovPath, 'utf-8')
const blocks = raw.split('end_of_record').map((b) => b.trim()).filter(Boolean)

const entries: Entry[] = []
for (const block of blocks) {
  let file = ''
  let LF = 0
  let LH = 0
  let FNF = 0
  let FNH = 0
  for (const line of block.split('\n')) {
    if (line.startsWith('SF:')) file = line.slice(3).trim()
    else if (line.startsWith('LF:')) LF = parseInt(line.slice(3)) || 0
    else if (line.startsWith('LH:')) LH = parseInt(line.slice(3)) || 0
    else if (line.startsWith('FNF:')) FNF = parseInt(line.slice(4)) || 0
    else if (line.startsWith('FNH:')) FNH = parseInt(line.slice(4)) || 0
  }
  if (!file) continue
  const linePct = LF === 0 ? 100 : Number(((LH / LF) * 100).toFixed(2))
  const funcPct = FNF === 0 ? 100 : Number(((FNH / FNF) * 100).toFixed(2))
  entries.push({
    package: packageFor(file),
    file,
    LH,
    LF,
    FNH,
    FNF,
    linePct,
    funcPct,
    gapLH: LF - LH,
    gapFN: FNF - FNH,
    bucket: bucketFor(file, linePct, funcPct),
  })
}

const bucketRank: Record<Entry['bucket'], number> = { B: 0, C: 1, D: 2, A: 3, X: 4 }
entries.sort((a, b) => {
  const r = bucketRank[a.bucket] - bucketRank[b.bucket]
  if (r !== 0) return r
  const g = b.gapLH - a.gapLH
  if (g !== 0) return g
  return a.file.localeCompare(b.file)
})

const totals = entries.reduce(
  (acc, e) => {
    if (e.bucket === 'X') return acc
    acc.LF += e.LF
    acc.LH += e.LH
    acc.FNF += e.FNF
    acc.FNH += e.FNH
    acc.byBucket[e.bucket] = (acc.byBucket[e.bucket] || 0) + 1
    return acc
  },
  { LF: 0, LH: 0, FNF: 0, FNH: 0, byBucket: {} as Record<string, number> },
)

const summary = {
  generatedAt: new Date().toISOString(),
  sourceLcov: lcovPath,
  totals: {
    files: entries.filter((e) => e.bucket !== 'X').length,
    LH: totals.LH,
    LF: totals.LF,
    FNH: totals.FNH,
    FNF: totals.FNF,
    linePct: Number(((totals.LH / totals.LF) * 100).toFixed(2)),
    funcPct: Number(((totals.FNH / totals.FNF) * 100).toFixed(2)),
    bucketCounts: totals.byBucket,
    excludedFiles: entries.filter((e) => e.bucket === 'X').length,
  },
  entries,
}

console.log(JSON.stringify(summary, null, 2))
