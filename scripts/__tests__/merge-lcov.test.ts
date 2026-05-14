// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Regression coverage for `scripts/merge-lcov.ts`.
 *
 * The most important property we test here is *path normalization*:
 * Bun's lcov reporter can emit three different shapes for the same
 * source file depending on which shard produced it (already repo-
 * relative, package-relative, or absolute). All three must collapse to
 * the same repo-rooted key so the merger sums their line hits instead
 * of treating them as three distinct files. The historical bug — fixed
 * alongside this test — was that already-repo-relative paths got
 * double-prefixed (`apps/api/packages/shared-runtime/src/foo.ts`),
 * which both inflated the denominator and split the hit counts across
 * keys.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'

import { normalizeSourceFile } from '../merge-lcov'

const REPO_ROOT = '/repo'

describe('normalizeSourceFile', () => {
  test('passes through already-repo-relative paths unchanged', () => {
    // Even when the shard cwd disagrees with the path, an SF: that's
    // already keyed against the repo root must NOT be re-resolved.
    expect(
      normalizeSourceFile(
        'packages/shared-runtime/src/s3-sync.ts',
        '/repo/apps/api',
        REPO_ROOT,
      ),
    ).toBe('packages/shared-runtime/src/s3-sync.ts')

    expect(
      normalizeSourceFile(
        'apps/api/src/routes/voice.ts',
        '/repo/packages/agent-runtime',
        REPO_ROOT,
      ),
    ).toBe('apps/api/src/routes/voice.ts')
  })

  test('resolves package-relative paths against the shard cwd', () => {
    expect(
      normalizeSourceFile('src/foo.ts', '/repo/packages/shared-runtime', REPO_ROOT),
    ).toBe('packages/shared-runtime/src/foo.ts')
  })

  test('normalises ../ shaped package-relative paths', () => {
    // Pre-fix behaviour: this returned `../shared-runtime/src/foo.ts`.
    expect(
      normalizeSourceFile(
        '../shared-runtime/src/foo.ts',
        '/repo/packages/agent-runtime',
        REPO_ROOT,
      ),
    ).toBe('packages/shared-runtime/src/foo.ts')
  })

  test('rebases absolute paths inside the repo', () => {
    expect(
      normalizeSourceFile(
        '/repo/packages/sdk/src/index.ts',
        '/repo/apps/api',
        REPO_ROOT,
      ),
    ).toBe('packages/sdk/src/index.ts')
  })

  test('keeps absolute paths outside the repo intact', () => {
    expect(
      normalizeSourceFile(
        '/elsewhere/lib/foo.ts',
        '/repo/apps/api',
        REPO_ROOT,
      ),
    ).toBe('/elsewhere/lib/foo.ts')
  })

  test('recognises every documented repo-root prefix', () => {
    for (const prefix of ['packages', 'apps', 'e2e', 'scripts', 'templates', 'infra', 'terraform', 'k8s']) {
      const sf = `${prefix}/foo/bar.ts`
      expect(normalizeSourceFile(sf, '/repo/apps/api', REPO_ROOT)).toBe(sf)
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end merger: build a tiny tree of lcov shards on disk, invoke the
// merger as a subprocess, and assert against the produced lcov + exit
// code. This exercises the parse → merge → emit → threshold pipeline.
// ---------------------------------------------------------------------------

interface ParsedRecord {
  sourceFile: string
  lineHits: Map<number, number>
  linesFound: number
  linesHit: number
}

function parseMergedLcov(text: string): Map<string, ParsedRecord> {
  const out = new Map<string, ParsedRecord>()
  let cur: ParsedRecord | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
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
      cur = { sourceFile: rest, lineHits: new Map(), linesFound: 0, linesHit: 0 }
      out.set(rest, cur)
    } else if (cur && tag === 'DA') {
      const [ln, hits] = rest.split(',').map(Number)
      cur.lineHits.set(ln, hits)
    } else if (cur && tag === 'LF') {
      cur.linesFound = Number(rest)
    } else if (cur && tag === 'LH') {
      cur.linesHit = Number(rest)
    }
  }
  return out
}

const MERGE_LCOV = resolve(import.meta.dir, '..', 'merge-lcov.ts')

describe('merge-lcov CLI', () => {
  let tmp: string

  beforeEach(() => {
    tmp = join(tmpdir(), `merge-lcov-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmp, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  })

  function writeShard(relPath: string, body: string): string {
    const full = join(tmp, relPath)
    mkdirSync(resolve(full, '..'), { recursive: true })
    writeFileSync(full, body)
    return full
  }

  function runMerger(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const proc = spawnSync('bun', ['run', MERGE_LCOV, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? '',
      exitCode: proc.status ?? 1,
    }
  }

  test('merges two shards that report the same source from different shard cwds', () => {
    // The historical bug: bun-test emits SF: as already-repo-relative
    // (e.g. `packages/shared-runtime/src/foo.ts`) but the previous
    // merger did `resolve(shardCwd, sf)` for every path. With shard A
    // living under `packages/shared-runtime/coverage/` and shard B
    // living under `apps/api/coverage/`, the resolution produced two
    // distinct keys for the same file
    // (`packages/shared-runtime/packages/shared-runtime/src/foo.ts` and
    // `apps/api/packages/shared-runtime/src/foo.ts`), splitting the
    // hit counts. After the fix, both shards collapse to a single
    // record whose DA lines are SUMMED.
    const shardA = writeShard(
      'packages/shared-runtime/coverage/lcov.info',
      [
        'TN:',
        'SF:packages/shared-runtime/src/foo.ts',
        'DA:1,1',
        'DA:2,0',
        'DA:3,1',
        'LF:3',
        'LH:2',
        'end_of_record',
        '',
      ].join('\n'),
    )
    const shardB = writeShard(
      'apps/api/coverage/lcov.info',
      [
        'TN:',
        'SF:packages/shared-runtime/src/foo.ts',
        'DA:1,0',
        'DA:2,1',
        'DA:3,1',
        'LF:3',
        'LH:2',
        'end_of_record',
        '',
      ].join('\n'),
    )

    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger([
      '-o', outFile,
      '--silent',
      shardA,
      shardB,
    ])
    expect(result.exitCode).toBe(0)

    const merged = parseMergedLcov(readFileSync(outFile, 'utf-8'))
    expect(merged.size).toBe(1)
    const rec = merged.get('packages/shared-runtime/src/foo.ts')
    expect(rec).toBeDefined()
    // Line 1 hit by shard A but not B -> 1+0 = 1. Line 2 hit by B only
    // -> 0+1 = 1. Line 3 hit by both -> 1+1 = 2.
    expect(rec!.lineHits.get(1)).toBe(1)
    expect(rec!.lineHits.get(2)).toBe(1)
    expect(rec!.lineHits.get(3)).toBe(2)
    expect(rec!.linesFound).toBe(3)
    expect(rec!.linesHit).toBe(3)
  })

  test('exits 0 in soft-floor mode when below threshold but warns to stderr', () => {
    const shard = writeShard(
      'packages/foo/coverage/lcov.info',
      [
        'TN:',
        'SF:packages/foo/src/x.ts',
        'DA:1,1',
        'DA:2,0',
        'LF:2',
        'LH:1',
        'end_of_record',
        '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger([
      '-o', outFile,
      '--threshold-line', '0.9',
      '--silent',
      shard,
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('[WARN]')
    expect(result.stderr).toContain('soft-floor')
  })

  test('exits non-zero in --strict mode when below threshold', () => {
    const shard = writeShard(
      'packages/foo/coverage/lcov.info',
      [
        'TN:',
        'SF:packages/foo/src/x.ts',
        'DA:1,1',
        'DA:2,0',
        'LF:2',
        'LH:1',
        'end_of_record',
        '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger([
      '-o', outFile,
      '--strict',
      '--threshold-line', '0.9',
      '--silent',
      shard,
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('[BELOW]')
  })

  test('passes when aggregate meets threshold', () => {
    const shard = writeShard(
      'packages/foo/coverage/lcov.info',
      [
        'TN:',
        'SF:packages/foo/src/x.ts',
        'DA:1,1',
        'DA:2,1',
        'DA:3,1',
        'DA:4,0',
        'LF:4',
        'LH:3',
        'end_of_record',
        '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger([
      '-o', outFile,
      '--strict',
      '--threshold-line', '0.5',
      '--silent',
      shard,
    ])
    expect(result.exitCode).toBe(0)
  })

  test('sums line hits across multiple shards of the same file', () => {
    const shardA = writeShard(
      'a/coverage/lcov.info',
      [
        'TN:', 'SF:packages/foo/src/y.ts',
        'DA:10,3', 'DA:11,0', 'DA:12,1',
        'LF:3', 'LH:2', 'end_of_record', '',
      ].join('\n'),
    )
    const shardB = writeShard(
      'b/coverage/lcov.info',
      [
        'TN:', 'SF:packages/foo/src/y.ts',
        'DA:10,2', 'DA:11,5', 'DA:12,0',
        'LF:3', 'LH:2', 'end_of_record', '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger(['-o', outFile, '--silent', shardA, shardB])
    expect(result.exitCode).toBe(0)
    const merged = parseMergedLcov(readFileSync(outFile, 'utf-8'))
    const rec = merged.get('packages/foo/src/y.ts')!
    expect(rec.lineHits.get(10)).toBe(5)
    expect(rec.lineHits.get(11)).toBe(5)
    expect(rec.lineHits.get(12)).toBe(1)
    expect(rec.linesHit).toBe(3)
  })

  test('--summary-json emits per-package + aggregate totals', () => {
    const shardA = writeShard(
      'packages/foo/coverage/lcov.info',
      [
        'TN:', 'SF:packages/foo/src/a.ts',
        'DA:1,1', 'DA:2,1', 'DA:3,0',
        'LF:3', 'LH:2', 'end_of_record', '',
      ].join('\n'),
    )
    const shardB = writeShard(
      'apps/api/coverage/lcov.info',
      [
        'TN:', 'SF:apps/api/src/b.ts',
        'DA:1,1', 'DA:2,0',
        'LF:2', 'LH:1', 'end_of_record', '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'merged.lcov')
    const summaryFile = join(tmp, 'summary.json')
    const result = runMerger([
      '-o', outFile,
      '--summary-json', summaryFile,
      '--silent',
      shardA,
      shardB,
    ])
    expect(result.exitCode).toBe(0)
    const summary = JSON.parse(readFileSync(summaryFile, 'utf-8'))
    expect(summary.aggregate).toMatchObject({
      files: 2,
      linesFound: 5,
      linesHit: 3,
    })
    expect(summary.aggregate.linesPct).toBeCloseTo(60, 1)
    expect(summary.packages['packages/foo']).toMatchObject({
      files: 1,
      linesFound: 3,
      linesHit: 2,
    })
    expect(summary.packages['apps/api']).toMatchObject({
      files: 1,
      linesFound: 2,
      linesHit: 1,
    })
    expect(typeof summary.generatedAt).toBe('string')
  })

  test('--per-package-floor flags a package below its floor (strict)', () => {
    const shard = writeShard(
      'packages/foo/coverage/lcov.info',
      [
        'TN:', 'SF:packages/foo/src/a.ts',
        'DA:1,1', 'DA:2,0', 'DA:3,0', 'DA:4,0',
        'LF:4', 'LH:1', 'end_of_record', '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger([
      '-o', outFile,
      '--strict',
      '--per-package-floor', 'packages/foo:0.8',
      '--silent',
      shard,
    ])
    expect(result.exitCode).toBe(1)
  })

  test('--per-package-floor accepts a package at or above its floor', () => {
    const shard = writeShard(
      'packages/foo/coverage/lcov.info',
      [
        'TN:', 'SF:packages/foo/src/a.ts',
        'DA:1,1', 'DA:2,1', 'DA:3,1', 'DA:4,1',
        'LF:4', 'LH:4', 'end_of_record', '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger([
      '-o', outFile,
      '--strict',
      '--per-package-floor', 'packages/foo:0.8',
      '--silent',
      shard,
    ])
    expect(result.exitCode).toBe(0)
  })

  test('--per-package-floor flags a typo / unknown package as a breach', () => {
    const shard = writeShard(
      'packages/foo/coverage/lcov.info',
      [
        'TN:', 'SF:packages/foo/src/a.ts',
        'DA:1,1', 'LF:1', 'LH:1', 'end_of_record', '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger([
      '-o', outFile,
      '--strict',
      '--per-package-floor', 'packages/does-not-exist:0.8',
      '--silent',
      shard,
    ])
    expect(result.exitCode).toBe(1)
  })

  test('--include-package filters merged output to only the listed packages', () => {
    // Three shards spanning three packages. With --include-package
    // set to two of them, the third must be dropped from the lcov,
    // the per-package summary, AND the aggregate totals — the whole
    // point of the flag is to produce honest backend/frontend roll-
    // ups from the same shard pool.
    const shardApi = writeShard(
      'apps/api/coverage/lcov.info',
      [
        'TN:', 'SF:apps/api/src/a.ts',
        'DA:1,1', 'DA:2,1', 'DA:3,0',
        'LF:3', 'LH:2', 'end_of_record', '',
      ].join('\n'),
    )
    const shardMobile = writeShard(
      'apps/mobile/coverage/lcov.info',
      [
        'TN:', 'SF:apps/mobile/src/m.ts',
        'DA:1,0', 'DA:2,0', 'DA:3,0', 'DA:4,0',
        'LF:4', 'LH:0', 'end_of_record', '',
      ].join('\n'),
    )
    const shardSdk = writeShard(
      'packages/sdk/coverage/lcov.info',
      [
        'TN:', 'SF:packages/sdk/src/s.ts',
        'DA:1,1', 'DA:2,1',
        'LF:2', 'LH:2', 'end_of_record', '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'backend.lcov')
    const summaryFile = join(tmp, 'backend-summary.json')
    const result = runMerger([
      '-o', outFile,
      '--include-package', 'apps/api',
      '--include-package', 'packages/sdk',
      '--summary-json', summaryFile,
      '--silent',
      shardApi,
      shardMobile,
      shardSdk,
    ])
    expect(result.exitCode).toBe(0)
    const merged = parseMergedLcov(readFileSync(outFile, 'utf-8'))
    expect(merged.has('apps/api/src/a.ts')).toBe(true)
    expect(merged.has('packages/sdk/src/s.ts')).toBe(true)
    expect(merged.has('apps/mobile/src/m.ts')).toBe(false)
    const summary = JSON.parse(readFileSync(summaryFile, 'utf-8'))
    expect(Object.keys(summary.packages).sort()).toEqual(['apps/api', 'packages/sdk'])
    // Aggregate totals must reflect the filtered set: 3+2 = 5 lines
    // found, 2+2 = 4 hit. The dropped mobile shard's 4 unhit lines
    // must NOT pollute the denominator.
    expect(summary.aggregate).toMatchObject({
      files: 2,
      linesFound: 5,
      linesHit: 4,
    })
  })

  test('--include-package filters cross-package shard contamination', () => {
    // Bun emits cross-package coverage when a test in package A
    // transitively loads source from package B (e.g. agent-runtime
    // tests load shared-runtime sources). The shard nominally
    // belongs to A but the SF: keys point at B's source. The filter
    // must operate on `packageKey(SF:)` — the actual source location —
    // not on which input file the record came from.
    const contaminatedShard = writeShard(
      'apps/api/coverage/lcov.info',
      [
        // apps/api's own test exercising apps/api source
        'TN:', 'SF:apps/api/src/api.ts',
        'DA:1,1', 'LF:1', 'LH:1', 'end_of_record',
        // …and incidentally pulling in apps/mobile source via an
        // import chain. The mobile lines must be filtered out
        // even though they live in apps/api's lcov shard.
        'TN:', 'SF:apps/mobile/src/leak.ts',
        'DA:1,1', 'LF:1', 'LH:1', 'end_of_record', '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'backend.lcov')
    const summaryFile = join(tmp, 'backend-summary.json')
    const result = runMerger([
      '-o', outFile,
      '--include-package', 'apps/api',
      '--summary-json', summaryFile,
      '--silent',
      contaminatedShard,
    ])
    expect(result.exitCode).toBe(0)
    const merged = parseMergedLcov(readFileSync(outFile, 'utf-8'))
    expect(merged.has('apps/api/src/api.ts')).toBe(true)
    expect(merged.has('apps/mobile/src/leak.ts')).toBe(false)
    const summary = JSON.parse(readFileSync(summaryFile, 'utf-8'))
    expect(summary.packages['apps/mobile']).toBeUndefined()
  })

  test('--update-readme rewrites the default badge marker', () => {
    const shard = writeShard(
      'packages/foo/coverage/lcov.info',
      [
        'TN:', 'SF:packages/foo/src/a.ts',
        'DA:1,1', 'DA:2,1', 'DA:3,0',
        'LF:3', 'LH:2', 'end_of_record', '',
      ].join('\n'),
    )
    const readme = join(tmp, 'README.md')
    writeFileSync(readme, [
      '# Project',
      '',
      '<!-- coverage-badge -->',
      '[![Coverage](https://img.shields.io/badge/coverage-1.00%25-red)](./coverage/lcov.info)',
      '<!-- /coverage-badge -->',
      '',
      'Body.',
    ].join('\n'))
    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger([
      '-o', outFile,
      '--update-readme', readme,
      '--silent',
      shard,
    ])
    expect(result.exitCode).toBe(0)
    const updated = readFileSync(readme, 'utf-8')
    // 2/3 = 66.67% → yellow color tier; the badge link must still
    // point at coverage/lcov.info (the legacy default).
    expect(updated).toContain('coverage-66.67%25-yellow')
    expect(updated).toContain('](./coverage/lcov.info)')
    // Closing marker must still be present so a second update lands
    // back into the same block instead of duplicating it.
    expect(updated).toContain('<!-- /coverage-badge -->')
  })

  test('--badge-key supports labeled multi-badge READMEs (backend + frontend)', () => {
    // Two shards, run the merger twice — once for backend, once for
    // frontend — into the same README. The badges live under
    // distinct marker keys so neither overwrites the other.
    const backendShard = writeShard(
      'packages/be/coverage/lcov.info',
      [
        'TN:', 'SF:apps/api/src/a.ts',
        'DA:1,1', 'DA:2,1', 'DA:3,1', 'DA:4,0',
        'LF:4', 'LH:3', 'end_of_record', '',
      ].join('\n'),
    )
    const frontendShard = writeShard(
      'packages/fe/coverage/lcov.info',
      [
        'TN:', 'SF:apps/mobile/src/m.ts',
        'DA:1,1', 'DA:2,1',
        'LF:2', 'LH:2', 'end_of_record', '',
      ].join('\n'),
    )
    const readme = join(tmp, 'README.md')
    writeFileSync(readme, '# Project\n\nBody.\n')

    const backendOut = join(tmp, 'backend.lcov')
    const backendResult = runMerger([
      '-o', backendOut,
      '--update-readme', readme,
      '--badge-key', 'coverage-badge:backend',
      '--badge-label', 'backend coverage',
      '--badge-lcov-path', 'coverage/lcov.info',
      '--include-package', 'apps/api',
      '--silent',
      backendShard,
      frontendShard,
    ])
    expect(backendResult.exitCode).toBe(0)

    const frontendOut = join(tmp, 'frontend.lcov')
    const frontendResult = runMerger([
      '-o', frontendOut,
      '--update-readme', readme,
      '--badge-key', 'coverage-badge:frontend',
      '--badge-label', 'frontend coverage',
      '--badge-lcov-path', 'coverage/frontend-lcov.info',
      '--include-package', 'apps/mobile',
      '--silent',
      backendShard,
      frontendShard,
    ])
    expect(frontendResult.exitCode).toBe(0)

    const updated = readFileSync(readme, 'utf-8')
    // Both marker blocks must coexist — the second update did NOT
    // clobber the first.
    expect(updated).toContain('<!-- coverage-badge:backend -->')
    expect(updated).toContain('<!-- /coverage-badge:backend -->')
    expect(updated).toContain('<!-- coverage-badge:frontend -->')
    expect(updated).toContain('<!-- /coverage-badge:frontend -->')
    // Backend: 3/4 = 75% → yellowgreen, label "backend coverage".
    expect(updated).toContain('backend%20coverage-75.00%25-yellowgreen')
    expect(updated).toContain('](./coverage/lcov.info)')
    // Frontend: 2/2 = 100% → brightgreen, label "frontend coverage".
    expect(updated).toContain('frontend%20coverage-100.00%25-brightgreen')
    expect(updated).toContain('](./coverage/frontend-lcov.info)')
  })

  test('handles missing shard files gracefully', () => {
    // The runner sometimes passes a path that didn't actually exist
    // (a shard whose tests didn't execute any source). merge-lcov.ts
    // must not crash on that.
    const realShard = writeShard(
      'real/coverage/lcov.info',
      [
        'TN:', 'SF:packages/foo/src/z.ts',
        'DA:1,1', 'LF:1', 'LH:1', 'end_of_record', '',
      ].join('\n'),
    )
    const outFile = join(tmp, 'merged.lcov')
    const result = runMerger([
      '-o', outFile,
      '--silent',
      join(tmp, 'nonexistent/coverage/lcov.info'),
      realShard,
    ])
    expect(result.exitCode).toBe(0)
    const merged = parseMergedLcov(readFileSync(outFile, 'utf-8'))
    expect(merged.size).toBe(1)
  })
})
