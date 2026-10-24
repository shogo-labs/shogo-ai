// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The streaming archive writer: entries, checksums and the size guards that
 * turn an oversized workspace into a 413 instead of an OOM.
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { ArchiveWriter, WorkspaceExportTooLargeError } from '../archive'

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-archive-test-'))
  return { dir, path: join(dir, 'archive.zip') }
}

describe('ArchiveWriter', () => {
  test('writes a readable zip with the entries it was given, in order', async () => {
    const { dir, path } = tempPath()
    try {
      const writer = new ArchiveWriter(path)
      await writer.addJson('workspace.json', { hello: 'world' })
      await writer.addBytes('data/WorkItem.json', new TextEncoder().encode('[]'))
      await writer.addBytes('projects/p1/files/src/App.tsx', new TextEncoder().encode('export {}'))
      const result = await writer.finish()

      expect(result.bytes).toBeGreaterThan(0)
      expect(result.entries.map((entry) => entry.path)).toEqual([
        'workspace.json',
        'data/WorkItem.json',
        'projects/p1/files/src/App.tsx',
      ])

      const unzipped = unzipSync(new Uint8Array(readFileSync(path)))
      expect(Object.keys(unzipped).sort()).toEqual([
        'data/WorkItem.json',
        'projects/p1/files/src/App.tsx',
        'workspace.json',
      ])
      expect(new TextDecoder().decode(unzipped['workspace.json'])).toBe('{"hello":"world"}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reports a sha256 and byte count per entry', async () => {
    const { dir, path } = tempPath()
    try {
      const payload = new TextEncoder().encode('hello workspace')
      const writer = new ArchiveWriter(path)
      await writer.addBytes('a.txt', payload)
      const { entries } = await writer.finish()
      expect(entries).toEqual([
        {
          path: 'a.txt',
          bytes: payload.byteLength,
          sha256: createHash('sha256').update(payload).digest('hex'),
        },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses an archive over the byte cap, naming the biggest contributors', async () => {
    const { dir, path } = tempPath()
    try {
      const writer = new ArchiveWriter(path, { maxTotalBytes: 20, maxFiles: 100 })
      await writer.addBytes('small.txt', new TextEncoder().encode('1234567890'))
      let caught: any
      try {
        await writer.addBytes('big.txt', new TextEncoder().encode('abcdefghijklmnop'))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(WorkspaceExportTooLargeError)
      expect(caught.limit).toBe('bytes')
      expect(caught.code).toBe('workspace_export_too_large')
      expect(caught.contributors[0].path).toBe('small.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses more entries than the file cap', async () => {
    const { dir, path } = tempPath()
    try {
      const writer = new ArchiveWriter(path, { maxTotalBytes: 1024, maxFiles: 1 })
      await writer.addBytes('one.txt', new TextEncoder().encode('1'))
      let caught: any
      try {
        await writer.addBytes('two.txt', new TextEncoder().encode('2'))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(WorkspaceExportTooLargeError)
      expect(caught.limit).toBe('files')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an empty archive is still a valid zip', async () => {
    const { dir, path } = tempPath()
    try {
      const writer = new ArchiveWriter(path)
      const result = await writer.finish()
      expect(result.entries).toEqual([])
      expect(existsSync(path)).toBe(true)
      expect(unzipSync(new Uint8Array(readFileSync(path)))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('abort leaves no usable archive behind', async () => {
    const { dir, path } = tempPath()
    try {
      const writer = new ArchiveWriter(path)
      await writer.addBytes('a.txt', new TextEncoder().encode('a'))
      writer.abort()
      expect(() => unzipSync(new Uint8Array(readFileSync(path)))).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
