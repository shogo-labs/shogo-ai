// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectArtifacts, MAX_ARTIFACT_CHARS, readArtifact, workspaceRelative } from '../channel-artifacts'
import { FileStateCache } from '../file-state-cache'

let dir: string
const write = (rel: string, content: string | Buffer) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), content)
}
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-artifacts-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('workspace paths', () => {
  test('relative and absolute paths inside the workspace; nothing outside it', () => {
    expect(workspaceRelative(dir, 'plans/a.md')).toBe('plans/a.md')
    expect(workspaceRelative(dir, './plans/a.md')).toBe('plans/a.md')
    expect(workspaceRelative(dir, join(dir, 'plans/a.md'))).toBe('plans/a.md')
    expect(workspaceRelative(dir, '../etc/passwd')).toBeNull()
    expect(workspaceRelative(dir, '/etc/passwd')).toBeNull()
    expect(workspaceRelative(dir, 'https://example.com/a.md')).toBeNull()
  })
})

describe('reading a file to attach', () => {
  test('text with the hash of the whole file, cut when long', () => {
    write('plans/a.md', '# Plan\n')
    expect(readArtifact(dir, 'plans/a.md')).toEqual({ path: 'plans/a.md', content: '# Plan\n', sha256: sha('# Plan\n') })
    const long = 'x'.repeat(MAX_ARTIFACT_CHARS + 5)
    write('long.md', long)
    expect(readArtifact(dir, 'long.md')).toMatchObject({ truncated: true, sha256: sha(long), content: long.slice(0, MAX_ARTIFACT_CHARS) })
  })

  test('missing, binary and outside files explain why', () => {
    write('img.png', Buffer.from([0x89, 0x50, 0x00, 0x01]))
    expect(readArtifact(dir, 'nope.md')).toBe('nope.md: not found')
    expect(readArtifact(dir, 'img.png')).toBe('img.png: not a text file; link it instead')
    expect(readArtifact(dir, '../x.md')).toBe('../x.md: not a file in your workspace')
  })
})

describe('what a post attaches', () => {
  test('named files and card file links, with errors for bad ones', () => {
    write('plans/a.md', 'A')
    write('specs/b.md', 'B')
    const out = collectArtifacts({
      workspaceDir: dir,
      attach: ['plans/a.md', 'missing.md'],
      card: { title: 'x', links: [{ url: 'specs/b.md' }, { url: 'https://github.com/a/b/pull/1' }] },
      writtenThisTurn: ['notes/other.md'],
      decision: true,
    })
    expect(out.artifacts.map((a) => a.path)).toEqual(['plans/a.md', 'specs/b.md'])
    expect(out.errors).toEqual(['missing.md: not found'])
    expect(out.auto).toBe(false)
  })

  test('a decision naming nothing gets the documents written this turn, newest first, not bookkeeping or code', () => {
    write('plans/old.md', 'old')
    write('plans/new.md', 'new')
    write('MEMORY.md', 'memory')
    write('memory/2026-10-14.md', 'log')
    write('src/fix.ts', 'code')
    const written = ['plans/old.md', 'src/fix.ts', 'MEMORY.md', 'memory/2026-10-14.md', 'plans/new.md']
    const out = collectArtifacts({ workspaceDir: dir, writtenThisTurn: written, decision: true })
    expect(out.auto).toBe(true)
    expect(out.artifacts.map((a) => a.path)).toEqual(['plans/new.md', 'plans/old.md'])
    expect(collectArtifacts({ workspaceDir: dir, writtenThisTurn: written, decision: false }).artifacts).toEqual([])
  })
})

describe('files written this turn', () => {
  test('every write is kept in order, a subagent\'s writes fold back, and a new turn clears them', () => {
    const cache = new FileStateCache('/ws')
    cache.markWrittenThisTurn('/ws/plans/a.md')
    cache.markWrittenThisTurn('notes.txt')
    cache.markWrittenThisTurn('./plans/a.md')
    expect(cache.getWrittenThisTurn()).toEqual(['notes.txt', 'plans/a.md'])
    const sub = cache.clone()
    sub.markWrittenThisTurn('plans/b.md')
    cache.mergeNewerReads(sub)
    expect(cache.getWrittenThisTurn()).toEqual(['notes.txt', 'plans/a.md', 'plans/b.md'])
    cache.resetTurn()
    expect(cache.getWrittenThisTurn()).toEqual([])
  })
})
