// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { existsSync } from 'fs'
import { resolveRgPath } from '../rg-resolve'

describe('resolveRgPath', () => {
  test('returns a non-empty string', () => {
    const rg = resolveRgPath()
    expect(typeof rg).toBe('string')
    expect(rg.length).toBeGreaterThan(0)
  })

  test('resolves to a real file from @vscode/ripgrep', () => {
    const rg = resolveRgPath()
    // If @vscode/ripgrep is installed, the path should point to an actual binary
    if (rg !== 'rg') {
      expect(existsSync(rg)).toBe(true)
    }
  })

  test('resolved path contains rg in its name', () => {
    const rg = resolveRgPath()
    const lower = rg.toLowerCase()
    expect(lower).toContain('rg')
  })

  test('returns the same value on subsequent calls (cached)', () => {
    const first = resolveRgPath()
    const second = resolveRgPath()
    expect(first).toBe(second)
  })
})
