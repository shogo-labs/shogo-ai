// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// Mock marketplace-install.service to control getWorkspacesDir
let workspacesDirOverride = ''
mock.module('../marketplace-install.service', () => ({
  getWorkspacesDir: () => workspacesDirOverride,
}))

const mm = await import('../marketplace-manifest.service')

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex')
}

let tmpRoot = ''
beforeEach(() => {
  tmpRoot = join(tmpdir(), `mm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpRoot, { recursive: true })
  workspacesDirOverride = tmpRoot
})
afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
})

function makeProject(projectId: string, files: Record<string, string | Buffer>) {
  const root = join(tmpRoot, projectId)
  mkdirSync(root, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

// ─────────────────────────────────────────────────────────────────────────────
describe('computeWorkspaceManifest', () => {
  it('returns {} when project dir does not exist', () => {
    expect(mm.computeWorkspaceManifest('does-not-exist')).toEqual({})
  })

  it('returns {} for empty project dir', () => {
    makeProject('p1', {})
    expect(mm.computeWorkspaceManifest('p1')).toEqual({})
  })

  it('hashes a flat file tree', () => {
    makeProject('p1', { 'a.txt': 'hello', 'b.txt': 'world' })
    const r = mm.computeWorkspaceManifest('p1')
    expect(r['a.txt']).toBe(sha256Hex('hello'))
    expect(r['b.txt']).toBe(sha256Hex('world'))
    expect(Object.keys(r)).toHaveLength(2)
  })

  it('descends into subdirectories with forward-slash keys', () => {
    makeProject('p1', { 'src/index.ts': 'export default 1' })
    const r = mm.computeWorkspaceManifest('p1')
    expect(r['src/index.ts']).toBe(sha256Hex('export default 1'))
  })

  it('excludes node_modules / .git / dist / .next / build / .turbo / .expo / .cache', () => {
    makeProject('p1', {
      'src/app.ts': 'kept',
      'node_modules/pkg/index.js': 'ignored',
      '.git/HEAD': 'ignored',
      'dist/bundle.js': 'ignored',
      '.next/cache.txt': 'ignored',
      'build/out.js': 'ignored',
      '.turbo/log': 'ignored',
      '.expo/manifest.json': 'ignored',
      '.cache/index': 'ignored',
    })
    const r = mm.computeWorkspaceManifest('p1')
    expect(Object.keys(r)).toEqual(['src/app.ts'])
  })

  it('excludes any path segment starting with ".install-"', () => {
    makeProject('p1', {
      'a.txt': 'kept',
      '.install-1234/state.json': 'ignored',
    })
    const r = mm.computeWorkspaceManifest('p1')
    expect(Object.keys(r)).toEqual(['a.txt'])
  })

  it('excludes lock files (bun.lock, bun.lockb, package-lock.json, yarn.lock, .DS_Store)', () => {
    makeProject('p1', {
      'package.json': '{}',
      'bun.lock': 'noise',
      'bun.lockb': 'noise',
      'package-lock.json': 'noise',
      'yarn.lock': 'noise',
      '.DS_Store': 'noise',
    })
    const r = mm.computeWorkspaceManifest('p1')
    expect(Object.keys(r)).toEqual(['package.json'])
  })

  it('continues past unreadable entries (broken symlink etc.) without throwing', () => {
    // Hard to portably create a broken file — instead verify that an empty
    // un-walkable dir at the root short-circuits without exploding.
    workspacesDirOverride = '/does/not/exist'
    expect(mm.computeWorkspaceManifest('p1')).toEqual({})
  })

  it('swallows readdirSync errors mid-walk and continues (covers walkDir catch)', () => {
    // Set up p1 with a readable file and an unreadable subdirectory.
    // The top-level readdirSync succeeds, walkDir descends into `blocked/`,
    // readdirSync of `blocked/` throws EACCES → catch { return } fires
    // (line 134) and the surviving readable entries are still hashed.
    makeProject('p1', { 'keep.txt': 'kept' })
    const blocked = join(tmpRoot, 'p1', 'blocked')
    mkdirSync(blocked, { recursive: true })
    writeFileSync(join(blocked, 'hidden.txt'), 'hidden')
    chmodSync(blocked, 0o000)
    try {
      const r = mm.computeWorkspaceManifest('p1')
      expect(r['keep.txt']).toBe(sha256Hex('kept'))
      expect(r['blocked/hidden.txt']).toBeUndefined()
    } finally {
      chmodSync(blocked, 0o755) // let afterEach rm -rf clean up
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('computeSnapshotManifest', () => {
  it('returns {} for non-object inputs', () => {
    expect(mm.computeSnapshotManifest(null)).toEqual({})
    expect(mm.computeSnapshotManifest(undefined)).toEqual({})
    expect(mm.computeSnapshotManifest('foo')).toEqual({})
    expect(mm.computeSnapshotManifest([1, 2, 3])).toEqual({})
  })

  it('hashes a flat utf8 file map', () => {
    const r = mm.computeSnapshotManifest({ 'a.txt': 'hello', 'b.txt': 'world' })
    expect(r['a.txt']).toBe(sha256Hex('hello'))
    expect(r['b.txt']).toBe(sha256Hex('world'))
  })

  it('unwraps { files: ... } envelope', () => {
    const r = mm.computeSnapshotManifest({ files: { 'a.txt': 'hello' } })
    expect(r['a.txt']).toBe(sha256Hex('hello'))
  })

  it('decodes wrapped objects with explicit encoding', () => {
    const r = mm.computeSnapshotManifest({
      'a.txt': { data: 'aGVsbG8=', encoding: 'base64' },
      'b.txt': { data: 'world', encoding: 'utf8' },
    })
    expect(r['a.txt']).toBe(sha256Hex('hello'))
    expect(r['b.txt']).toBe(sha256Hex('world'))
  })

  it('defaults wrapped objects with missing encoding to utf8', () => {
    const r = mm.computeSnapshotManifest({ 'a.txt': { data: 'hi' } })
    expect(r['a.txt']).toBe(sha256Hex('hi'))
  })

  it('skips entries with unsupported value shapes', () => {
    const r = mm.computeSnapshotManifest({ 'a.txt': 42, 'b.txt': null, 'c.txt': { weird: 1 } })
    expect(Object.keys(r)).toEqual([])
  })

  it('rejects absolute paths and parent-traversal', () => {
    const r = mm.computeSnapshotManifest({
      '/etc/shadow': 'evil',
      '../../../escape': 'evil',
      'safe.txt': 'kept',
    })
    expect(Object.keys(r)).toEqual(['safe.txt'])
  })

  it('drops the literal "files" key when present alongside a wrapper', () => {
    const r = mm.computeSnapshotManifest({
      files: { 'a.txt': 'hello' },
      // The wrapper path returns { 'a.txt': ... } and the literal "files"
      // key is shadowed by the unwrap — verify final shape is right.
    })
    expect(Object.keys(r)).toEqual(['a.txt'])
  })

  it('applies manifest-style exclusions to snapshot input (dist/ excluded)', () => {
    const r = mm.computeSnapshotManifest({
      'src/index.ts': 'kept',
      'dist/bundle.js': 'ignored',
      'node_modules/pkg/x.js': 'ignored',
    })
    expect(Object.keys(r).sort()).toEqual(['src/index.ts'])
  })

  it('produces byte-identical hashes to computeWorkspaceManifest', () => {
    makeProject('p1', { 'a.txt': 'hello', 'src/b.ts': 'world' })
    const fromDisk = mm.computeWorkspaceManifest('p1')
    const fromSnap = mm.computeSnapshotManifest({ 'a.txt': 'hello', 'src/b.ts': 'world' })
    expect(fromSnap).toEqual(fromDisk)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('diffManifests', () => {
  it('returns empty diff for null/undefined inputs', () => {
    expect(mm.diffManifests(null, null)).toEqual({ added: [], modified: [], deleted: [] })
    expect(mm.diffManifests(undefined, undefined)).toEqual({ added: [], modified: [], deleted: [] })
  })

  it('detects added files (in current but not baseline)', () => {
    const d = mm.diffManifests({ 'a.txt': 'h1' }, { 'a.txt': 'h1', 'b.txt': 'h2' })
    expect(d.added).toEqual(['b.txt'])
    expect(d.modified).toEqual([])
    expect(d.deleted).toEqual([])
  })

  it('detects modified files (same key, different hash)', () => {
    const d = mm.diffManifests({ 'a.txt': 'h1' }, { 'a.txt': 'h2' })
    expect(d.modified).toEqual(['a.txt'])
  })

  it('detects deleted files (in baseline but not current)', () => {
    const d = mm.diffManifests({ 'a.txt': 'h1', 'b.txt': 'h2' }, { 'a.txt': 'h1' })
    expect(d.deleted).toEqual(['b.txt'])
  })

  it('sorts all three buckets alphabetically', () => {
    const d = mm.diffManifests(
      { 'old1.txt': 'h', 'old2.txt': 'h', 'mod.txt': 'm1' },
      { 'mod.txt': 'm2', 'zzz.txt': 'h', 'aaa.txt': 'h' },
    )
    expect(d.added).toEqual(['aaa.txt', 'zzz.txt'])
    expect(d.deleted).toEqual(['old1.txt', 'old2.txt'])
    expect(d.modified).toEqual(['mod.txt'])
  })

  it('returns zero diff for byte-identical manifests', () => {
    const m = { a: 'h1', b: 'h2' }
    expect(mm.diffManifests(m, m)).toEqual({ added: [], modified: [], deleted: [] })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('snapshotProjectWorkspace', () => {
  it('returns {} when project dir does not exist', () => {
    expect(mm.snapshotProjectWorkspace('does-not-exist')).toEqual({})
  })

  it('emits utf8 strings for text files', () => {
    makeProject('p1', { 'a.txt': 'hello', 'src/b.ts': 'export default 1' })
    const s = mm.snapshotProjectWorkspace('p1')
    expect(s['a.txt']).toBe('hello')
    expect(s['src/b.ts']).toBe('export default 1')
  })

  it('emits base64 wrapper for binary files (NUL byte sniffed)', () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) // PNG-like with NUL
    makeProject('p1', { 'img.png': bin })
    const s = mm.snapshotProjectWorkspace('p1')
    expect(typeof s['img.png']).toBe('object')
    const wrapped = s['img.png'] as any
    expect(wrapped.encoding).toBe('base64')
    expect(Buffer.from(wrapped.data, 'base64').equals(bin)).toBe(true)
  })

  it('skips files > 5MB', () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 'x') // 6MB
    makeProject('p1', { 'big.txt': big, 'small.txt': 'kept' })
    const s = mm.snapshotProjectWorkspace('p1')
    expect(s['big.txt']).toBeUndefined()
    expect(s['small.txt']).toBe('kept')
  })

  it('swallows readdirSync errors mid-walk in snapshotWalk (covers catch line 291)', () => {
    // Mirror of the walkDir test above for the snapshot variant: a readable
    // text file at root + an unreadable subdirectory. snapshotWalk hits
    // readdirSync(EACCES) for `locked/` → catch { return } at line 291 fires
    // and the rest of the tree is still snapshotted.
    makeProject('p1', { 'a.txt': 'visible' })
    const locked = join(tmpRoot, 'p1', 'locked')
    mkdirSync(locked, { recursive: true })
    writeFileSync(join(locked, 'inner.txt'), 'hidden')
    chmodSync(locked, 0o000)
    try {
      const s = mm.snapshotProjectWorkspace('p1')
      expect(s['a.txt']).toBe('visible')
      expect(s['locked/inner.txt']).toBeUndefined()
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('INCLUDES dist/ (snapshot exclusion list differs from manifest)', () => {
    makeProject('p1', { 'dist/bundle.js': 'pre-built' })
    const s = mm.snapshotProjectWorkspace('p1')
    expect(s['dist/bundle.js']).toBe('pre-built')
  })

  it('excludes node_modules / .git / .next / .turbo / .expo / .cache from snapshot', () => {
    makeProject('p1', {
      'kept.ts': 'yes',
      'node_modules/x.js': 'no',
      '.git/HEAD': 'no',
      '.next/x.txt': 'no',
      '.turbo/x.txt': 'no',
      '.expo/x.txt': 'no',
      '.cache/x.txt': 'no',
    })
    const s = mm.snapshotProjectWorkspace('p1')
    expect(Object.keys(s)).toEqual(['kept.ts'])
  })

  it('skips entries with .install- prefix in snapshot output', () => {
    makeProject('p1', { 'kept.ts': 'yes', '.install-abc/state.json': 'no' })
    const s = mm.snapshotProjectWorkspace('p1')
    expect(Object.keys(s)).toEqual(['kept.ts'])
  })
})
