// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the packageBuildEnv helper in scripts/build-packages.ts.
 *
 * The script's top-level build loop is guarded by import.meta.main semantics
 * (Bun only runs top-level await when it is the entry point), so importing
 * the named export here does not trigger any build work.
 *
 *   bun test scripts/__tests__/build-packages.test.ts
 */
import { describe, expect, it } from 'bun:test'
import { packageBuildEnv } from '../build-packages.ts'

describe('packageBuildEnv', () => {
  it('adds --max-old-space-size=8192 when NODE_OPTIONS is absent', () => {
    const env = packageBuildEnv({})
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=8192')
  })

  it('prepends the flag and preserves existing NODE_OPTIONS flags', () => {
    const env = packageBuildEnv({ NODE_OPTIONS: '--enable-source-maps' })
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=8192')
    expect(env.NODE_OPTIONS).toContain('--enable-source-maps')
  })

  it('leaves NODE_OPTIONS unchanged when --max-old-space-size is already set', () => {
    const env = packageBuildEnv({ NODE_OPTIONS: '--max-old-space-size=4096' })
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096')
    expect(env.NODE_OPTIONS).not.toContain('8192')
  })

  it('does not mutate the caller env object', () => {
    const original: NodeJS.ProcessEnv = {}
    packageBuildEnv(original)
    expect(original.NODE_OPTIONS).toBeUndefined()
  })

  it('passes through all other env keys unchanged', () => {
    const env = packageBuildEnv({ PATH: '/usr/bin', HOME: '/root' })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/root')
  })
})
