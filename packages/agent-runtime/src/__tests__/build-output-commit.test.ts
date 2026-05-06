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
