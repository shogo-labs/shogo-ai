// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reserved Windows device names (SHO-180 / #1686): one untracked `nul` used to
 * stop the workspace's git sync forever, because a path Windows cannot index
 * makes `git add` fail on every cycle.
 */

import { describe, test, expect } from 'bun:test'
import { findReservedPaths, isWindowsReservedPath } from '../git-reserved-names'

describe('isWindowsReservedPath', () => {
  test('matches every reserved device name in any case', () => {
    for (const p of ['nul', 'NUL', 'Nul', 'con', 'prn', 'aux', 'com1', 'COM9', 'lpt1', 'LPT9']) {
      expect(isWindowsReservedPath(p)).toBe(true)
    }
  })

  test('matches a reserved name with an extension, since only the stem counts', () => {
    expect(isWindowsReservedPath('aux.txt')).toBe(true)
    expect(isWindowsReservedPath('nul.log')).toBe(true)
    expect(isWindowsReservedPath('CON.md')).toBe(true)
  })

  test('matches a reserved name in any path segment, Windows or POSIX separators', () => {
    expect(isWindowsReservedPath('sub/CON')).toBe(true)
    expect(isWindowsReservedPath('a/b/nul')).toBe(true)
    expect(isWindowsReservedPath('a\\b\\aux.txt')).toBe(true)
  })

  test('leaves ordinary paths alone', () => {
    for (const p of ['', 'nulify.ts', 'console.ts', 'com10', 'lpt0', 'mynul', 'nullable']) {
      expect(isWindowsReservedPath(p)).toBe(false)
    }
  })

  test('a dotted reserved name is still reserved — Windows reads con.ts as con', () => {
    expect(isWindowsReservedPath('src/con.ts')).toBe(true)
  })

  test('findReservedPaths keeps order and drops the rest', () => {
    expect(findReservedPaths(['src/a.ts', 'nul', 'sub/CON', 'aux.txt', 'b.ts']))
      .toEqual(['nul', 'sub/CON', 'aux.txt'])
  })
})
