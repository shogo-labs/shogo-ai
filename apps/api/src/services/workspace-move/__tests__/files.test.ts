// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resumable file transfer, without a network.
 *
 * `diffFileManifest` is what makes a dropped connection cheap: the second run of
 * a move re-walks the source, asks the target what it holds, and sends only the
 * difference. These tests drive it with two real temporary directories so the
 * hashes and the ignore numbers are the ones a real move would use.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeRelPath, diffFileManifest, walkMoveFiles, writeMoveFile } from '../files'

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-move-'))
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

describe('walkMoveFiles', () => {
  test('hashes what it carries and reports what the ignores saved', async () => {
    const dir = project({
      'src/index.ts': 'export const a = 1\n',
      'posts/one.md': 'hello\n',
      'out/render.mp4': 'x'.repeat(5000),
      '.tmp/scratch.bin': 'y'.repeat(1000),
      'node_modules/react/index.js': 'module.exports = {}\n',
    })
    const result = await walkMoveFiles(dir)
    const paths = result.entries.map((entry) => entry.path).sort()
    expect(paths).toEqual(['posts/one.md', 'src/index.ts'])
    expect(result.ignored.files).toBe(3)
    expect(result.ignored.bytes).toBe(5000 + 1000 + 'module.exports = {}\n'.length)
    expect(result.entries.every((entry) => entry.sha256.length === 64)).toBe(true)
  })

  test('stat-only mode is what the plan step uses', async () => {
    const dir = project({ 'a.txt': 'abc' })
    const result = await walkMoveFiles(dir, { hash: false })
    expect(result.entries[0]?.bytes).toBe(3)
    expect(result.entries[0]?.sha256).toBe('')
  })

  test('never follows a symlink out of the project', async () => {
    const outside = project({ 'secret.txt': 'nope' })
    const dir = project({ 'ok.txt': 'fine' })
    symlinkSync(outside, join(dir, 'escape'))
    const result = await walkMoveFiles(dir)
    expect(result.entries.map((entry) => entry.path)).toEqual(['ok.txt'])
    expect(result.errors.some((error) => error.reason === 'symlink-outside-root')).toBe(true)
  })
})

describe('diffFileManifest', () => {
  test('a resumed move sends only what the target does not have', async () => {
    const dir = project({ 'a.txt': 'one', 'b.txt': 'two', 'c.txt': 'three' })
    const source = await walkMoveFiles(dir)

    // The target got a.txt and a *partial* b.txt before the connection dropped.
    const target = [
      source.entries.find((entry) => entry.path === 'a.txt')!,
      { path: 'b.txt', bytes: 1, sha256: 'stale-hash' },
    ]
    const diff = diffFileManifest(source.entries, target)
    expect(diff.toSend.map((entry) => entry.path)).toEqual(['b.txt', 'c.txt'])
    expect(diff.skipped).toBe(1)
    expect(diff.skippedBytes).toBe(3)
  })

  test('same size but different content is re-sent', () => {
    const diff = diffFileManifest(
      [{ path: 'a.txt', bytes: 3, sha256: 'aaa' }],
      [{ path: 'a.txt', bytes: 3, sha256: 'bbb' }],
    )
    expect(diff.toSend).toHaveLength(1)
  })

  test('a finished move re-sends nothing', () => {
    const entries = [
      { path: 'a.txt', bytes: 1, sha256: 'x' },
      { path: 'b/c.txt', bytes: 2, sha256: 'y' },
    ]
    expect(diffFileManifest(entries, entries).toSend).toEqual([])
  })
})

describe('writeMoveFile', () => {
  test('writes inside the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-move-write-'))
    const target = writeMoveFile(dir, 'deep/nested/file.txt', new TextEncoder().encode('hi'))
    expect(target.startsWith(dir)).toBe(true)
  })

  test('refuses to escape the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-move-write-'))
    expect(() => writeMoveFile(dir, '../escape.txt', new Uint8Array([1]))).toThrow()
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow()
    expect(() => assertSafeRelPath('a/../../b')).toThrow()
  })
})
