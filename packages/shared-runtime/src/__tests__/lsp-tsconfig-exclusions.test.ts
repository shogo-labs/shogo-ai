// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `patchTsconfigWatchExclusions` — the helper the LSP manager
 * uses to keep tsserver from walking node_modules/dist during program load.
 *
 * Workspace runtimes call this once per attached project's tsconfig (the
 * merged-tree parent usually has none), so the per-file, idempotent,
 * malformed-tolerant behaviour matters.
 *
 *   bun test packages/shared-runtime/src/__tests__/lsp-tsconfig-exclusions.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { patchTsconfigWatchExclusions } from '../lsp-service'

let DIR: string

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'shogo-tsconfig-patch-'))
})
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

const REQUIRED = ['**/node_modules', '**/dist', '**/.git', '**/.shogo']

describe('patchTsconfigWatchExclusions', () => {
  test('adds excludeDirectories to a tsconfig that lacks them', () => {
    const p = join(DIR, 'tsconfig.json')
    writeFileSync(p, JSON.stringify({ compilerOptions: { strict: true } }))
    const wrote = patchTsconfigWatchExclusions(p)
    expect(wrote).toBe(true)
    const cfg = JSON.parse(readFileSync(p, 'utf-8'))
    for (const r of REQUIRED) expect(cfg.watchOptions.excludeDirectories).toContain(r)
    // Untouched compilerOptions survive.
    expect(cfg.compilerOptions.strict).toBe(true)
  })

  test('merges with pre-existing excludeDirectories without dropping them', () => {
    const p = join(DIR, 'tsconfig.json')
    writeFileSync(p, JSON.stringify({ watchOptions: { excludeDirectories: ['**/custom'] } }))
    expect(patchTsconfigWatchExclusions(p)).toBe(true)
    const cfg = JSON.parse(readFileSync(p, 'utf-8'))
    expect(cfg.watchOptions.excludeDirectories).toContain('**/custom')
    for (const r of REQUIRED) expect(cfg.watchOptions.excludeDirectories).toContain(r)
  })

  test('is idempotent — second call makes no change', () => {
    const p = join(DIR, 'tsconfig.json')
    writeFileSync(p, JSON.stringify({}))
    expect(patchTsconfigWatchExclusions(p)).toBe(true)
    const first = readFileSync(p, 'utf-8')
    expect(patchTsconfigWatchExclusions(p)).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe(first)
  })

  test('no-op (false) when the tsconfig is absent', () => {
    expect(patchTsconfigWatchExclusions(join(DIR, 'nope', 'tsconfig.json'))).toBe(false)
  })

  test('tolerates malformed JSON without throwing', () => {
    const p = join(DIR, 'tsconfig.json')
    writeFileSync(p, '{ this is not json ')
    expect(patchTsconfigWatchExclusions(p)).toBe(false)
    // File left untouched.
    expect(readFileSync(p, 'utf-8')).toBe('{ this is not json ')
  })

  test('models the workspace case: patches each attached project tsconfig independently', () => {
    // parent (merged-tree root) has no tsconfig; two project subfolders do.
    const a = join(DIR, 'proj-a')
    const b = join(DIR, 'proj-b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    writeFileSync(join(a, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))
    writeFileSync(join(b, 'tsconfig.json'), JSON.stringify({ watchOptions: { excludeDirectories: ['**/out'] } }))

    expect(patchTsconfigWatchExclusions(join(DIR, 'tsconfig.json'))).toBe(false) // parent: none
    expect(patchTsconfigWatchExclusions(join(a, 'tsconfig.json'))).toBe(true)
    expect(patchTsconfigWatchExclusions(join(b, 'tsconfig.json'))).toBe(true)

    const bCfg = JSON.parse(readFileSync(join(b, 'tsconfig.json'), 'utf-8'))
    expect(bCfg.watchOptions.excludeDirectories).toContain('**/out')
    for (const r of REQUIRED) expect(bCfg.watchOptions.excludeDirectories).toContain(r)
  })
})
