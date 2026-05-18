// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  migrateRuntimeTemplate,
  CANONICAL_MAIN_TSX,
  CANONICAL_SHOGO_ERROR_BOUNDARY_TSX,
  RUNTIME_BRIDGE_VERSION,
} from '../canvas-bridge-migration'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cbm-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const MAIN = () => join(dir, 'src/main.tsx')
const EB   = () => join(dir, 'src/ShogoErrorBoundary.tsx')
const MARK = () => join(dir, '.shogo-runtime-version')

describe('migrateRuntimeTemplate', () => {
  it('returns no-main-tsx when main.tsx does not exist', () => {
    const r = migrateRuntimeTemplate(dir)
    expect(r.rewrote).toBe(false)
    expect(r.reason).toBe('no-main-tsx')
  })

  it('returns already-canonical when marker + both files match', () => {
    writeFileSync(MAIN(), CANONICAL_MAIN_TSX)
    writeFileSync(EB(), CANONICAL_SHOGO_ERROR_BOUNDARY_TSX)
    writeFileSync(MARK(), `${RUNTIME_BRIDGE_VERSION}\n`)
    const r = migrateRuntimeTemplate(dir)
    expect(r.rewrote).toBe(false)
    expect(r.reason).toBe('already-canonical')
    expect(r.path).toBe(MAIN())
  })

  it('rewrites a drifted main.tsx and stamps the marker', () => {
    writeFileSync(MAIN(), '// old custom bridge code')
    writeFileSync(EB(), CANONICAL_SHOGO_ERROR_BOUNDARY_TSX)
    writeFileSync(MARK(), `${RUNTIME_BRIDGE_VERSION}\n`)
    const r = migrateRuntimeTemplate(dir)
    expect(r.rewrote).toBe(true)
    expect(r.paths).toEqual(['src/main.tsx'])
    expect(r.reason).toBe('content-drift')
    expect(readFileSync(MAIN(), 'utf-8')).toBe(CANONICAL_MAIN_TSX)
    expect(readFileSync(MARK(), 'utf-8').trim()).toBe(String(RUNTIME_BRIDGE_VERSION))
  })

  it('rewrites with reason=version-bump when marker is older', () => {
    writeFileSync(MAIN(), 'old')
    writeFileSync(MARK(), '0\n')
    const r = migrateRuntimeTemplate(dir)
    expect(r.rewrote).toBe(true)
    expect(r.reason).toBe('version-bump')
  })

  it('writes the missing ShogoErrorBoundary on a v1-migrated workspace', () => {
    writeFileSync(MAIN(), CANONICAL_MAIN_TSX)
    writeFileSync(MARK(), '1\n')
    const r = migrateRuntimeTemplate(dir)
    expect(r.rewrote).toBe(true)
    expect(r.paths).toContain('src/ShogoErrorBoundary.tsx')
    expect(readFileSync(EB(), 'utf-8')).toBe(CANONICAL_SHOGO_ERROR_BOUNDARY_TSX)
  })

  it('treats an unparseable marker as version 0 (rewrites)', () => {
    writeFileSync(MAIN(), CANONICAL_MAIN_TSX)
    writeFileSync(EB(), CANONICAL_SHOGO_ERROR_BOUNDARY_TSX)
    writeFileSync(MARK(), 'garbage')
    const r = migrateRuntimeTemplate(dir)
    // Files are already canonical, but marker is stale → version-bump w/ no rewrites
    expect(r.rewrote).toBe(false)
    expect(r.reason).toBe('version-bump')
    expect(r.paths).toEqual([])
  })

  it('rewrites both files when neither is canonical', () => {
    writeFileSync(MAIN(), 'old main')
    writeFileSync(EB(), 'old boundary')
    const r = migrateRuntimeTemplate(dir)
    expect(r.rewrote).toBe(true)
    expect(new Set(r.paths)).toEqual(new Set(['src/main.tsx', 'src/ShogoErrorBoundary.tsx']))
  })

  it('is idempotent across two consecutive calls', () => {
    writeFileSync(MAIN(), 'old')
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r1 = migrateRuntimeTemplate(dir)
      expect(r1.rewrote).toBe(true)
      const r2 = migrateRuntimeTemplate(dir)
      expect(r2.rewrote).toBe(false)
      expect(r2.reason).toBe('already-canonical')
    } finally {
      log.mockRestore()
    }
  })
})

describe('canonical strings', () => {
  it('CANONICAL_MAIN_TSX imports ShogoErrorBoundary', () => {
    expect(CANONICAL_MAIN_TSX).toContain('ShogoErrorBoundary')
    expect(CANONICAL_MAIN_TSX).toContain('createRoot')
  })

  it('CANONICAL_SHOGO_ERROR_BOUNDARY_TSX defines a React boundary', () => {
    expect(CANONICAL_SHOGO_ERROR_BOUNDARY_TSX).toContain('ShogoErrorBoundary')
    expect(CANONICAL_SHOGO_ERROR_BOUNDARY_TSX).toContain('componentDidCatch')
  })
})
