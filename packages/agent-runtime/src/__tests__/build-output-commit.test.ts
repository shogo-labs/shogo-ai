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
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import {
  commitBuildOutput,
  cleanupStagingOutput,
  withFsRetry,
  DEFAULT_STAGING_DIR,
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
    let calls = 0
    expect(() => {
      withFsRetry(() => {
        calls++
        throw eperm()
      })
    }).toThrow(/EPERM/)
    // 1 initial attempt + 7 retry slots = 8 total before giving up.
    expect(calls).toBe(8)
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
