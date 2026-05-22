// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, test, expect } from 'bun:test'
import { existsSync } from 'fs'
import { _rgResolveSeamForTests, resolveRgPath } from '../rg-resolve'

describe('resolveRgPath', () => {
  // Snapshot the seam defaults once so we can restore them after each
  // test that mutates them — keeps the public tests below order-independent.
  const defaultRequire = _rgResolveSeamForTests.require
  const defaultExistsSync = _rgResolveSeamForTests.existsSync

  afterEach(() => {
    _rgResolveSeamForTests.require = defaultRequire
    _rgResolveSeamForTests.existsSync = defaultExistsSync
    _rgResolveSeamForTests.reset()
  })

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

  test('falls back to "rg" when require(@vscode/ripgrep) throws (catch arm)', () => {
    // Covers the \`} catch { /* package not installed */ }\` arm + the
    // \`_resolved = "rg"\` fallback at the bottom of the function.
    _rgResolveSeamForTests.reset()
    _rgResolveSeamForTests.require = () => {
      throw new Error("Cannot find module '@vscode/ripgrep'")
    }
    expect(resolveRgPath()).toBe('rg')
  })

  test('falls back to "rg" when the bundled binary path does not exist on disk', () => {
    // Covers the if-false path through the try block — require returns a
    // path, existsSync(path) is false → execution reaches the closing
    // brace and falls into the \`_resolved = "rg"\` fallback.
    _rgResolveSeamForTests.reset()
    _rgResolveSeamForTests.require = () => ({ rgPath: '/nonexistent/ripgrep' })
    _rgResolveSeamForTests.existsSync = () => false
    expect(resolveRgPath()).toBe('rg')
  })

  test('reset() clears the module-private cache so the next call re-resolves', () => {
    const first = resolveRgPath()
    _rgResolveSeamForTests.require = () => {
      throw new Error('forced miss')
    }
    // Without reset(), the cached value would be returned and the catch
    // path would not re-run; with reset() the next call re-enters the try.
    expect(resolveRgPath()).toBe(first)
    _rgResolveSeamForTests.reset()
    expect(resolveRgPath()).toBe('rg')
  })
})
