// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for `services/marketplace-manifest.service.ts`.
 *
 * Two of the three exports (`computeWorkspaceManifest`,
 * `snapshotProjectWorkspace`) walk the real filesystem, so we use a
 * tmp directory under `tmpdir()` and an env-overridden
 * `WORKSPACES_DIR`. `diffManifests` and `computeSnapshotManifest` are
 * pure and exercised with literal inputs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  computeWorkspaceManifest,
  computeSnapshotManifest,
  diffManifests,
  snapshotProjectWorkspace,
} from '../services/marketplace-manifest.service'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'manifest-test-'))
  process.env.WORKSPACES_DIR = tmpRoot
})

afterEach(() => {
  delete process.env.WORKSPACES_DIR
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

function makeProject(id: string, files: Record<string, string | Buffer>): string {
  const root = join(tmpRoot, id)
  mkdirSync(root, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body as Buffer | string)
  }
  return root
}

// ─── computeWorkspaceManifest ───────────────────────────────────────

describe('computeWorkspaceManifest', () => {
  test('returns empty for missing project dir', () => {
    expect(computeWorkspaceManifest('does-not-exist')).toEqual({})
  })

  test('hashes every non-excluded file with stable forward-slash keys', () => {
    makeProject('p1', {
      'src/index.ts': 'console.log(1)',
      'README.md': '# hi',
      'node_modules/leaked.js': 'should not appear',
      '.git/HEAD': 'should not appear',
      'dist/build.js': 'should not appear',
      '.DS_Store': 'should not appear',
    })
    const m = computeWorkspaceManifest('p1')
    expect(Object.keys(m).sort()).toEqual(['README.md', 'src/index.ts'])
    // Hashes are deterministic — same input always same output.
    expect(m['src/index.ts']).toBe(computeWorkspaceManifest('p1')['src/index.ts'])
    expect(m['README.md']).toMatch(/^[a-f0-9]{64}$/)
  })

  test('different content yields different hash', () => {
    makeProject('a', { 'a.txt': 'one' })
    const ha = computeWorkspaceManifest('a')['a.txt']
    rmSync(join(tmpRoot, 'a'), { recursive: true })
    makeProject('a', { 'a.txt': 'two' })
    const hb = computeWorkspaceManifest('a')['a.txt']
    expect(ha).not.toBe(hb)
  })
})

// ─── computeSnapshotManifest ────────────────────────────────────────

describe('computeSnapshotManifest', () => {
  test('matches on-disk manifest for the same content', () => {
    makeProject('p2', { 'a.txt': 'hello world' })
    const onDisk = computeWorkspaceManifest('p2')
    const fromSnap = computeSnapshotManifest({ files: { 'a.txt': 'hello world' } })
    expect(fromSnap).toEqual(onDisk)
  })

  test('accepts both flat and {files: ...} shapes', () => {
    const flat = computeSnapshotManifest({ 'a.txt': 'x' })
    const wrapped = computeSnapshotManifest({ files: { 'a.txt': 'x' } })
    expect(flat).toEqual(wrapped)
  })

  test('decodes base64 entries', () => {
    const utf8 = computeSnapshotManifest({ 'a.bin': 'hello' })
    const base64 = computeSnapshotManifest({
      'a.bin': { data: Buffer.from('hello').toString('base64'), encoding: 'base64' },
    })
    expect(base64).toEqual(utf8)
  })

  test('skips traversal paths and excluded segments', () => {
    const m = computeSnapshotManifest({
      'good.txt': 'ok',
      '../escape': 'no',
      '/abs': 'no',
      'node_modules/x.js': 'no',
      '.git/HEAD': 'no',
    })
    expect(Object.keys(m)).toEqual(['good.txt'])
  })

  test('null/non-object inputs return {}', () => {
    expect(computeSnapshotManifest(null)).toEqual({})
    expect(computeSnapshotManifest(undefined)).toEqual({})
    expect(computeSnapshotManifest([])).toEqual({})
    expect(computeSnapshotManifest('nope')).toEqual({})
  })
})

// ─── diffManifests ──────────────────────────────────────────────────

describe('diffManifests', () => {
  test('classifies added / modified / deleted', () => {
    const baseline = { 'a.txt': 'h1', 'b.txt': 'h2', 'c.txt': 'h3' }
    const current = { 'a.txt': 'h1', 'b.txt': 'h2x', 'd.txt': 'h4' }
    const diff = diffManifests(baseline, current)
    expect(diff.added).toEqual(['d.txt'])
    expect(diff.modified).toEqual(['b.txt'])
    expect(diff.deleted).toEqual(['c.txt'])
  })

  test('null arguments are treated as empty', () => {
    expect(diffManifests(null, { 'a.txt': 'h' })).toEqual({
      added: ['a.txt'],
      modified: [],
      deleted: [],
    })
    expect(diffManifests({ 'a.txt': 'h' }, null)).toEqual({
      added: [],
      modified: [],
      deleted: ['a.txt'],
    })
  })

  test('identical manifests produce no diff', () => {
    const m = { 'a.txt': 'x', 'b.txt': 'y' }
    expect(diffManifests(m, { ...m })).toEqual({ added: [], modified: [], deleted: [] })
  })

  test('output arrays are sorted', () => {
    const baseline = { 'z.txt': 'h', 'm.txt': 'h' }
    const current = { 'a.txt': 'h', 'b.txt': 'h' }
    const diff = diffManifests(baseline, current)
    expect(diff.added).toEqual(['a.txt', 'b.txt'])
    expect(diff.deleted).toEqual(['m.txt', 'z.txt'])
  })
})

// ─── snapshotProjectWorkspace ───────────────────────────────────────

describe('snapshotProjectWorkspace', () => {
  test('utf8 files become string entries, binary become base64 wrappers', () => {
    makeProject('p3', {
      'src/text.ts': 'export const x = 1',
      'src/bin.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a]),
    })
    const snap = snapshotProjectWorkspace('p3')
    expect(snap['src/text.ts']).toBe('export const x = 1')
    expect(typeof snap['src/bin.png']).toBe('object')
    expect(
      (snap['src/bin.png'] as { encoding: string; data: string }).encoding,
    ).toBe('base64')
  })

  test('round-trip: snapshotProjectWorkspace -> computeSnapshotManifest matches computeWorkspaceManifest', () => {
    makeProject('p4', {
      'a.txt': 'alpha',
      'sub/b.txt': 'beta',
    })
    const onDisk = computeWorkspaceManifest('p4')
    const snapshot = snapshotProjectWorkspace('p4')
    const fromSnap = computeSnapshotManifest({ files: snapshot })
    expect(fromSnap).toEqual(onDisk)
  })

  test('respects excluded segments', () => {
    makeProject('p5', {
      'keep.txt': 'k',
      'node_modules/leak.js': 'leak',
    })
    const snap = snapshotProjectWorkspace('p5')
    expect(Object.keys(snap)).toEqual(['keep.txt'])
  })

  test('returns {} for missing project dir', () => {
    expect(snapshotProjectWorkspace('does-not-exist')).toEqual({})
  })
})
