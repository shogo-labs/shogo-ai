// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for SHOG-749.
 *
 * These assertions are written with `join()` / `sep` rather than literal
 * separators so they are meaningful on every platform: on Windows they
 * exercise backslash-separated paths, on POSIX forward slashes. The
 * pre-fix implementation (`resolved.startsWith(root + '/')`) fails the
 * "child is inside root" cases on Windows and the "sibling prefix"
 * case everywhere.
 */
import { describe, test, expect } from 'bun:test'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CASE_INSENSITIVE_FS,
  dedupeRoots,
  isWithinAnyRoot,
  isWithinRoot,
  normalizeForCompare,
} from '../path-boundary'

const root = resolve(join(tmpdir(), 'shogo-path-boundary'))

describe('isWithinRoot', () => {
  test('the root itself is within the root', () => {
    expect(isWithinRoot(root, root)).toBe(true)
  })

  test('a direct child is within the root', () => {
    expect(isWithinRoot(root, join(root, 'config.json'))).toBe(true)
  })

  test('a deeply nested child is within the root', () => {
    expect(isWithinRoot(root, join(root, 'apps', 'desktop', 'src', 'preload.ts'))).toBe(true)
  })

  test('a relative path is resolved against the root', () => {
    expect(isWithinRoot(root, join(root, '.shogo', 'logs', 'build.log'))).toBe(true)
  })

  test('a parent directory is NOT within the root', () => {
    expect(isWithinRoot(root, resolve(root, '..'))).toBe(false)
  })

  test('a traversal escape is NOT within the root', () => {
    expect(isWithinRoot(root, resolve(root, '..', '..', 'etc', 'passwd'))).toBe(false)
  })

  test('a SIBLING whose name merely starts with the root name is NOT within it', () => {
    // The bug a bare startsWith(root) misses: `/workspace-evil` is not in `/workspace`.
    expect(isWithinRoot(root, root + '-evil')).toBe(false)
    expect(isWithinRoot(root, root + '-evil' + sep + 'secrets.txt')).toBe(false)
  })

  test('trailing separator on the root is tolerated', () => {
    expect(isWithinRoot(root + sep, join(root, 'config.json'))).toBe(true)
  })

  test('case folding follows the platform', () => {
    const upper = join(root.toUpperCase(), 'config.json')
    expect(isWithinRoot(root, upper)).toBe(CASE_INSENSITIVE_FS)
  })
})

describe('isWithinAnyRoot', () => {
  const other = resolve(join(tmpdir(), 'shogo-other-root'))

  test('matches when the candidate is under the second root', () => {
    expect(isWithinAnyRoot([root, other], join(other, 'x.ts'))).toBe(true)
  })

  test('rejects when the candidate is under neither root', () => {
    expect(isWithinAnyRoot([root, other], resolve(tmpdir(), 'shogo-third', 'x.ts'))).toBe(false)
  })

  test('rejects against an empty root list', () => {
    expect(isWithinAnyRoot([], join(root, 'x.ts'))).toBe(false)
  })
})

describe('dedupeRoots', () => {
  test('collapses the workspaceDir + LINKED_FOLDERS duplicate', () => {
    // Folder-linked projects pass the same directory twice, which is why the
    // "Allowed roots" error message printed it repeatedly.
    expect(dedupeRoots([root, root])).toEqual([root])
  })

  test('preserves order and distinct roots', () => {
    const other = resolve(join(tmpdir(), 'shogo-other-root'))
    expect(dedupeRoots([root, other, root])).toEqual([root, other])
  })

  test('treats a trailing separator as the same root', () => {
    expect(dedupeRoots([root, root + sep])).toHaveLength(1)
  })

  test('folds case only where the filesystem does', () => {
    const folded = dedupeRoots([root, root.toUpperCase()])
    expect(folded).toHaveLength(CASE_INSENSITIVE_FS ? 1 : 2)
  })
})

describe('normalizeForCompare', () => {
  test('is a no-op on case-sensitive filesystems', () => {
    const out = normalizeForCompare('/Foo/Bar')
    expect(out).toBe(CASE_INSENSITIVE_FS ? '/foo/bar' : '/Foo/Bar')
  })
})
