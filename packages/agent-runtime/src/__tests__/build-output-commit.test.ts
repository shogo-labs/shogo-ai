// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for the atomic dist-swap commit helpers. These pin the
// contract that `dist/` is never wiped before a successful build —
// which is the whole reason the helpers exist (a refresh during the
// build window used to 404, and a failed build used to leave 404 in
// place permanently).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync as realRenameSync,
  rmSync,
  rmSync as realRmSync,
  writeFileSync,
  type PathLike,
  type RmOptions,
} from 'fs'
import { join } from 'path'
import {
  commitBuildOutput,
  commitBuildOutputAsync,
  cleanupStagingOutput,
  withFsRetry,
  DEFAULT_STAGING_DIR,
  __resetCommitQueuesForTest,
  __setRetryDelaysForTest,
  __setFsImplForTest,
  __getRetryScheduleLengthForTest,
} from '../build-output-commit'

const TMP = '/tmp/test-build-output-commit'

function freshWorkspace(): void {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
}

function seedDir(rel: string, files: Record<string, string>): void {
  const full = join(TMP, rel)
  mkdirSync(full, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(full, name), contents)
  }
}

describe('commitBuildOutput', () => {
  beforeEach(freshWorkspace)
  afterEach(() => rmSync(TMP, { recursive: true, force: true }))

  test('promotes dist.staging into dist when dist already exists', () => {
    seedDir('dist', { 'index.html': 'old' })
    seedDir(DEFAULT_STAGING_DIR, { 'index.html': 'new' })

    const ok = commitBuildOutput(TMP, DEFAULT_STAGING_DIR)
    expect(ok).toBe(true)

    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')).toBe('new')
    expect(existsSync(join(TMP, DEFAULT_STAGING_DIR))).toBe(false)
    expect(existsSync(join(TMP, 'dist.prev'))).toBe(false)
  })

  test('promotes dist.staging into dist on first-ever build (no prior dist)', () => {
    seedDir(DEFAULT_STAGING_DIR, { 'index.html': 'new' })

    const ok = commitBuildOutput(TMP, DEFAULT_STAGING_DIR)
    expect(ok).toBe(true)

    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')).toBe('new')
    expect(existsSync(join(TMP, DEFAULT_STAGING_DIR))).toBe(false)
  })

  test('removes a stale dist.prev left behind by a prior crashed swap', () => {
    seedDir('dist', { 'index.html': 'old' })
    seedDir('dist.prev', { 'index.html': 'ancient' })
    seedDir(DEFAULT_STAGING_DIR, { 'index.html': 'new' })

    const ok = commitBuildOutput(TMP, DEFAULT_STAGING_DIR)
    expect(ok).toBe(true)

    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')).toBe('new')
    expect(existsSync(join(TMP, 'dist.prev'))).toBe(false)
  })

  test('returns false and leaves dist untouched when staging is missing', () => {
    seedDir('dist', { 'index.html': 'old' })

    const ok = commitBuildOutput(TMP, DEFAULT_STAGING_DIR)
    expect(ok).toBe(false)

    // The previous build must remain serveable. This is the contract
    // that prevents the "build deletes dist, refresh 404s" regression.
    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')).toBe('old')
  })

  test('preserves dist contents when called with a non-empty staging dir', () => {
    seedDir('dist', { 'index.html': 'old', 'app.js': 'console.log(1)' })
    seedDir(DEFAULT_STAGING_DIR, { 'index.html': 'new', 'app.js': 'console.log(2)' })

    expect(commitBuildOutput(TMP, DEFAULT_STAGING_DIR)).toBe(true)

    // After commit the files should reflect the staged version
    // exclusively — old files at the same paths are replaced, not
    // merged.
    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')).toBe('new')
    expect(readFileSync(join(TMP, 'dist', 'app.js'), 'utf-8')).toBe('console.log(2)')
  })

  // Windows-specific behavior: AV / preview-server handles cause renameSync
  // to throw EPERM transiently. The commit must retry rather than abandon
  // the swap on the first failure — otherwise a Windows dev box gets stuck
  // serving stale builds whenever Defender is in the middle of a scan.
})

// The retry wrapper is the load-bearing piece for Windows resilience —
// without it, transient AV / preview-handle locks on `dist/` permanently
// strand a workspace on its previous build (see canvas-build-manager
// "Build succeeded but commit into dist/ failed" path). These tests pin
// the contract that motivated the retry and keep it from regressing.
describe('withFsRetry', () => {
  function eperm(): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error('EPERM: simulated lock')
    err.code = 'EPERM'
    return err
  }

  test('returns the op result on first success without retrying', () => {
    let calls = 0
    const result = withFsRetry(() => {
      calls++
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  test('retries through transient EPERM and eventually succeeds', () => {
    let calls = 0
    const result = withFsRetry(() => {
      calls++
      if (calls <= 3) throw eperm()
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(4)
  })

  test('retries EBUSY, EACCES, and ENOTEMPTY (full transient set)', () => {
    for (const code of ['EBUSY', 'EACCES', 'ENOTEMPTY']) {
      let calls = 0
      const result = withFsRetry(() => {
        calls++
        if (calls === 1) {
          const err: NodeJS.ErrnoException = new Error(`${code}: lock`)
          err.code = code
          throw err
        }
        return code
      })
      expect(result).toBe(code)
      expect(calls).toBe(2)
    }
  })

  test('rethrows after the retry budget is exhausted', () => {
    // Pin to a tiny synthetic schedule so this test doesn't sit on the
    // full Windows ~12s backoff. The *count* is what we're regressing —
    // wall-clock between attempts is sleep, not behavior.
    const restore = __setRetryDelaysForTest([0, 0, 0, 0, 0, 0, 0])
    try {
      let calls = 0
      expect(() => {
        withFsRetry(() => {
          calls++
          throw eperm()
        })
      }).toThrow(/EPERM/)
      // 1 initial attempt + N retry slots = N+1 total before giving up.
      expect(calls).toBe(__getRetryScheduleLengthForTest() + 1)
    } finally {
      restore()
    }
  })

  test('Windows default schedule is materially longer than POSIX (handles AV scans of large assets)', () => {
    // We don't pin the *exact* Windows budget (it's tunable), but it must
    // be at least 5x POSIX or it regresses to the previous failure mode
    // where 1.6s was empirically not enough to outlast a Defender scan
    // of a multi-megabyte asset (e.g. a 172 MB GLB in `public/`) and
    // `commitBuildOutput` returned false leaving the new build orphaned
    // in `dist.staging/`.
    if (process.platform !== 'win32') return
    expect(__getRetryScheduleLengthForTest()).toBeGreaterThanOrEqual(10)
  })

  test('does not retry non-transient errors (ENOENT bubbles immediately)', () => {
    let calls = 0
    expect(() => {
      withFsRetry(() => {
        calls++
        const err: NodeJS.ErrnoException = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      })
    }).toThrow(/ENOENT/)
    expect(calls).toBe(1)
  })
})

// Force-replace fallback. When `rename(dist, dist.prev)` exhausts the
// retry budget on Windows (the user-visible failure was an EPERM from a
// 172 MB GLB asset being scanned by Defender + the runtime's static
// handler streaming the file to the preview iframe), the commit must
// not give up: it must `rmSync(dist) + rename(staging, dist)` so the
// freshly-built output still lands. The trade-off — losing the
// `dist.prev/` rollback dir for that build only — is documented in the
// build-output-commit docstring.
describe('commitBuildOutput force-replace fallback', () => {
  let restoreSchedule: (() => void) | null = null
  let restoreFs: (() => void) | null = null

  beforeEach(() => {
    freshWorkspace()
    // Tight schedule so we exhaust retries fast; the test isn't about
    // backoff timing.
    restoreSchedule = __setRetryDelaysForTest([0, 0, 0])
  })

  afterEach(() => {
    restoreFs?.()
    restoreFs = null
    restoreSchedule?.()
    restoreSchedule = null
    rmSync(TMP, { recursive: true, force: true })
  })

  test('falls back to rmSync(dist) + rename(staging, dist) when rotation rename keeps throwing EPERM', () => {
    seedDir('dist', { 'index.html': 'old-locked' })
    seedDir(DEFAULT_STAGING_DIR, { 'index.html': 'new' })

    const distPath = join(TMP, 'dist')
    const prevPath = join(TMP, 'dist.prev')
    let rotationAttempts = 0

    restoreFs = __setFsImplForTest({
      renameSync: (from: PathLike, to: PathLike) => {
        // Only fail the dist→dist.prev rotation; staging→dist on the
        // fallback path should still succeed via the real fs.
        if (from === distPath && to === prevPath) {
          rotationAttempts++
          const err: NodeJS.ErrnoException = new Error('EPERM: simulated lock')
          err.code = 'EPERM'
          throw err
        }
        return realRenameSync(from, to)
      },
    })

    const ok = commitBuildOutput(TMP, DEFAULT_STAGING_DIR)
    expect(ok).toBe(true)

    // The new build landed despite the persistent rotation failure —
    // this is the whole point of the fallback.
    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')).toBe('new')
    expect(existsSync(join(TMP, DEFAULT_STAGING_DIR))).toBe(false)
    // `dist.prev/` should NOT exist: the fallback skipped rotation
    // entirely, removing dist directly. Pinning this means a future
    // change that preserves `dist.prev` even on the fallback path will
    // need to update this expectation explicitly.
    expect(existsSync(join(TMP, 'dist.prev'))).toBe(false)
    // We exhausted retries before falling back, not bailed on first try.
    expect(rotationAttempts).toBeGreaterThanOrEqual(2)
  })

  test('returns false (and keeps old dist serving) when even the fallback rmSync cannot break the lock', () => {
    seedDir('dist', { 'index.html': 'old-locked' })
    seedDir(DEFAULT_STAGING_DIR, { 'index.html': 'new' })

    const distPath = join(TMP, 'dist')
    const prevPath = join(TMP, 'dist.prev')

    restoreFs = __setFsImplForTest({
      renameSync: (from: PathLike, to: PathLike) => {
        if (from === distPath && to === prevPath) {
          const err: NodeJS.ErrnoException = new Error('EPERM: rename locked')
          err.code = 'EPERM'
          throw err
        }
        return realRenameSync(from, to)
      },
      rmSync: (target: PathLike, opts?: RmOptions) => {
        // Only deny the dist removal — the dist.prev cleanup at step 1
        // (when no prev exists) still needs to succeed (well, no-op)
        // and the post-swap prev cleanup is moot since we never get
        // there in this test.
        if (target === distPath) {
          const err: NodeJS.ErrnoException = new Error('EPERM: rm locked')
          err.code = 'EPERM'
          throw err
        }
        return realRmSync(target, opts)
      },
    })

    const ok = commitBuildOutput(TMP, DEFAULT_STAGING_DIR)

    expect(ok).toBe(false)
    // Old build must still be serveable. This is the contract.
    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')).toBe('old-locked')
    // Fresh build remains in staging for the next attempt.
    expect(readFileSync(join(TMP, DEFAULT_STAGING_DIR, 'index.html'), 'utf-8')).toBe('new')
  })
})

// Workspace-scoped commit mutex. PreviewManager (boot-time
// expo/vite seed) and CanvasBuildManager (per-edit canvas rebuilds)
// both call `commitBuildOutputAsync` against the same workspace's
// `dist/` and `dist.prev/`. Running them concurrently used to lose
// `dist.prev/` cleanup races — one's rmSync would delete the other's
// in-flight rename target. The mutex pins them into a queue so the
// second commit only starts after the first finishes its full
// rotation sequence.
describe('commitBuildOutputAsync workspace mutex', () => {
  beforeEach(() => {
    freshWorkspace()
    __resetCommitQueuesForTest()
  })

  afterEach(() => {
    __resetCommitQueuesForTest()
    rmSync(TMP, { recursive: true, force: true })
  })

  test('serializes concurrent commits against the same workspace', async () => {
    // Two staging dirs (PreviewManager + CanvasBuildManager pattern),
    // both committing into the same `dist/`.
    seedDir('dist', { 'index.html': 'gen-0' })
    seedDir('dist.staging', { 'index.html': 'gen-1-preview' })
    seedDir('dist.canvas.staging', { 'index.html': 'gen-2-canvas' })

    // Fire both in parallel. Whichever wins the lock first commits
    // first; the second sees `dist/` already populated and rotates
    // it normally. Without the mutex, both interleave inside step 1
    // (rmSync(dist.prev)) / step 2 (rename(dist, dist.prev)) and one
    // ends up clobbering the other's promoted output.
    const [okA, okB] = await Promise.all([
      commitBuildOutputAsync(TMP, 'dist.staging'),
      commitBuildOutputAsync(TMP, 'dist.canvas.staging'),
    ])

    expect(okA).toBe(true)
    expect(okB).toBe(true)

    // Whichever ran second wins `dist/`. Both staging dirs must be
    // gone; `dist.prev/` must be cleaned up. Most importantly: `dist/`
    // contains EXACTLY ONE of the two builds, never a mix or empty.
    const finalIndex = readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')
    expect(['gen-1-preview', 'gen-2-canvas']).toContain(finalIndex)
    expect(existsSync(join(TMP, 'dist.staging'))).toBe(false)
    expect(existsSync(join(TMP, 'dist.canvas.staging'))).toBe(false)
    expect(existsSync(join(TMP, 'dist.prev'))).toBe(false)
  })

  test('does not block commits in different workspaces (per-workspace queue, not global)', async () => {
    const wsA = join(TMP, 'workspace-a')
    const wsB = join(TMP, 'workspace-b')
    mkdirSync(wsA, { recursive: true })
    mkdirSync(wsB, { recursive: true })
    mkdirSync(join(wsA, DEFAULT_STAGING_DIR), { recursive: true })
    writeFileSync(join(wsA, DEFAULT_STAGING_DIR, 'index.html'), 'a')
    mkdirSync(join(wsB, DEFAULT_STAGING_DIR), { recursive: true })
    writeFileSync(join(wsB, DEFAULT_STAGING_DIR, 'index.html'), 'b')

    // No mock — just confirm both complete without one waiting on the
    // other unnecessarily. (We can't easily assert "ran in parallel"
    // without a synthetic delay; the regression we're guarding is
    // "one workspace's queue blocks another", which would manifest
    // as the second commit's tail Promise depending on the first's.)
    const [okA, okB] = await Promise.all([
      commitBuildOutputAsync(wsA, DEFAULT_STAGING_DIR),
      commitBuildOutputAsync(wsB, DEFAULT_STAGING_DIR),
    ])

    expect(okA).toBe(true)
    expect(okB).toBe(true)
    expect(readFileSync(join(wsA, 'dist', 'index.html'), 'utf-8')).toBe('a')
    expect(readFileSync(join(wsB, 'dist', 'index.html'), 'utf-8')).toBe('b')
  })
})

describe('cleanupStagingOutput', () => {
  beforeEach(freshWorkspace)
  afterEach(() => rmSync(TMP, { recursive: true, force: true }))

  test('removes a leftover staging dir', () => {
    seedDir(DEFAULT_STAGING_DIR, { 'index.html': 'partial' })
    cleanupStagingOutput(TMP, DEFAULT_STAGING_DIR)
    expect(existsSync(join(TMP, DEFAULT_STAGING_DIR))).toBe(false)
  })

  test('is a no-op when staging is absent', () => {
    expect(() => cleanupStagingOutput(TMP, DEFAULT_STAGING_DIR)).not.toThrow()
  })

  test('does not touch dist/', () => {
    seedDir('dist', { 'index.html': 'old' })
    seedDir(DEFAULT_STAGING_DIR, { 'index.html': 'partial' })

    cleanupStagingOutput(TMP, DEFAULT_STAGING_DIR)

    expect(existsSync(join(TMP, DEFAULT_STAGING_DIR))).toBe(false)
    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')).toBe('old')
  })
})
