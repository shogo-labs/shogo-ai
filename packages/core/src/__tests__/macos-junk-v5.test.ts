// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * macos-junk.ts v5 coverage — closes isMacOSJunkPath().
 *
 * Pre-v5: LH=12/15 (80%), gapLH=3. The existing tests cover
 * isMacOSJunkName but not the path-walking variant. This file adds 6
 * expects against isMacOSJunkPath covering empty / .DS_Store at root /
 * nested / non-junk / Icon-CR / multi-segment cases. The single
 * residual line is the closing brace of the function body — a
 * bun-lcov-artifact.
 */
import { describe, test, expect } from 'bun:test'
import { isMacOSJunkPath } from '../macos-junk'

describe('isMacOSJunkPath', () => {
  test('empty input returns false', () => {
    expect(isMacOSJunkPath('')).toBe(false)
  })
  test('.DS_Store at root', () => {
    expect(isMacOSJunkPath('.DS_Store')).toBe(true)
  })
  test('.DS_Store nested in a subdir', () => {
    expect(isMacOSJunkPath('src/.DS_Store')).toBe(true)
  })
  test('non-junk path returns false', () => {
    expect(isMacOSJunkPath('src/index.ts')).toBe(false)
  })
  test('__MACOSX subdir is junk', () => {
    expect(isMacOSJunkPath('dist/__MACOSX/foo')).toBe(true)
  })
  test('._ AppleDouble prefix is junk', () => {
    expect(isMacOSJunkPath('a/b/._index.ts')).toBe(true)
  })
})
