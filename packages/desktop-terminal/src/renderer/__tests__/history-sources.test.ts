// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  CommandHistorySource,
  DirectoryHistorySource,
  dedupe,
  fuzzyFilter,
  trackerAdapter,
  type CommandHistoryEntry,
  type HistoryReader,
  type MinimalTracker,
  type TrackerHistoryAdapter,
} from '../history/history-sources'

// ─── helpers ──────────────────────────────────────────────────────

function makeTracker(
  commands: Array<{ commandLine: string; cwd: string | null; exitCode: number | null }>,
  cwd: string | null = null,
): TrackerHistoryAdapter {
  return {
    commandHistory: () => commands,
    directoryHistory: () => {
      const dirs: string[] = []
      for (const c of commands) if (c.cwd) dirs.push(c.cwd)
      if (cwd) dirs.push(cwd)
      return dirs
    },
  }
}

// ─── dedupe + fuzzyFilter ────────────────────────────────────────

describe('dedupe', () => {
  it('keeps the first occurrence of each key', () => {
    const r = dedupe(
      [{ id: 'a', x: 1 }, { id: 'b', x: 2 }, { id: 'a', x: 3 }],
      (e) => e.id,
    )
    expect(r.map((e) => e.x)).toEqual([1, 2])
  })

  it('handles empty arrays', () => {
    expect(dedupe([], () => '')).toEqual([])
  })
})

describe('fuzzyFilter', () => {
  const items = [{ s: 'src/foo.ts' }, { s: 'docs/README.md' }, { s: 'src/foo.test.ts' }, { s: 'src/bar.ts' }]

  it('returns everything when query is empty', () => {
    expect(fuzzyFilter(items, (i) => i.s, '')).toEqual(items)
    expect(fuzzyFilter(items, (i) => i.s, '   ')).toEqual(items)
  })

  it('matches substrings case-insensitively', () => {
    const r = fuzzyFilter(items, (i) => i.s, 'foo')
    expect(r.map((x) => x.s)).toEqual(['src/foo.ts', 'src/foo.test.ts'])
  })

  it('matches multi-token queries in order', () => {
    const r = fuzzyFilter(items, (i) => i.s, 'src test')
    expect(r.map((x) => x.s)).toEqual(['src/foo.test.ts'])
  })

  it('returns empty for no matches', () => {
    expect(fuzzyFilter(items, (i) => i.s, 'qqq')).toEqual([])
  })
})

// ─── CommandHistorySource ────────────────────────────────────────

describe('CommandHistorySource', () => {
  const tracker = makeTracker([
    { commandLine: 'ls -la', cwd: '/tmp', exitCode: 0 },
    { commandLine: 'cat foo.txt', cwd: '/tmp', exitCode: 1 },
    { commandLine: 'ls -la', cwd: '/tmp', exitCode: 0 }, // duplicate (newer)
  ])

  it('returns tracker entries in recency-first order', () => {
    const src = new CommandHistorySource({ tracker })
    const list = src.list()
    expect(list.map((e) => e.command)).toEqual(['ls -la', 'cat foo.txt'])
    expect(list[0]!.exitCode).toBe(0)
  })

  it('skips blank commandLines', () => {
    const t = makeTracker([
      { commandLine: '', cwd: null, exitCode: null },
      { commandLine: 'echo hi', cwd: null, exitCode: 0 },
    ])
    const src = new CommandHistorySource({ tracker: t })
    expect(src.list().map((e) => e.command)).toEqual(['echo hi'])
  })

  it('filter delegates to fuzzyFilter', () => {
    const src = new CommandHistorySource({ tracker })
    expect(src.filter('cat').map((e) => e.command)).toEqual(['cat foo.txt'])
    expect(src.filter('ls').map((e) => e.command)).toEqual(['ls -la'])
  })

  it('loads disk history asynchronously and merges with tracker', async () => {
    const reader: HistoryReader = {
      async readBash(): Promise<string[]> { return ['nvim ~/.vimrc', 'git status', 'ls -la'] },
      async readZsh(): Promise<string[]> { return ['echo zsh', '', '  '] },
    }
    const src = new CommandHistorySource({ tracker, reader })
    expect(src.list().map((e) => e.command)).toEqual(['ls -la', 'cat foo.txt'])
    await src.refreshDisk()
    const after = src.list().map((e) => e.command)
    // tracker entries still come first; disk entries follow with dedupe.
    expect(after.slice(0, 2)).toEqual(['ls -la', 'cat foo.txt'])
    expect(after).toContain('nvim ~/.vimrc')
    expect(after).toContain('git status')
    expect(after).toContain('echo zsh')
    // duplicate "ls -la" from bash is suppressed.
    expect(after.filter((c) => c === 'ls -la')).toHaveLength(1)
  })

  it('returns the SAME promise for concurrent refreshDisk() calls', async () => {
    let calls = 0
    const reader: HistoryReader = {
      async readBash(): Promise<string[]> { calls++; await new Promise((r) => setTimeout(r, 5)); return [] },
    }
    const src = new CommandHistorySource({ tracker: makeTracker([]), reader })
    const a = src.refreshDisk()
    const b = src.refreshDisk()
    expect(a).toBe(b)
    await Promise.all([a, b])
    expect(calls).toBe(1)
  })

  it('survives a reader throwing', async () => {
    const reader: HistoryReader = {
      async readBash(): Promise<string[]> { throw new Error('no perms') },
      async readZsh(): Promise<string[]> { return ['zsh-cmd'] },
    }
    const src = new CommandHistorySource({ tracker: makeTracker([]), reader })
    await src.refreshDisk()
    expect(src.list().map((e) => e.command)).toEqual(['zsh-cmd'])
  })

  it('honours the limit option', () => {
    const cmds = Array.from({ length: 50 }, (_, i) => ({
      commandLine: `cmd-${i}`, cwd: null, exitCode: null,
    }))
    const src = new CommandHistorySource({ tracker: makeTracker(cmds), limit: 10 })
    expect(src.list()).toHaveLength(10)
    // limit is floored at 10 so anything < 10 yields exactly 10.
    const src2 = new CommandHistorySource({ tracker: makeTracker(cmds), limit: 1 })
    expect(src2.list()).toHaveLength(10)
  })

  it('resetDiskCache forces a re-read on next refreshDisk', async () => {
    let calls = 0
    const reader: HistoryReader = {
      async readBash(): Promise<string[]> { calls++; return ['x'] },
    }
    const src = new CommandHistorySource({ tracker: makeTracker([]), reader })
    await src.refreshDisk()
    src.resetDiskCache()
    await src.refreshDisk()
    expect(calls).toBe(2)
  })
})

// ─── DirectoryHistorySource ───────────────────────────────────────

describe('DirectoryHistorySource', () => {
  const tracker = makeTracker(
    [
      { commandLine: 'a', cwd: '/tmp', exitCode: 0 },
      { commandLine: 'b', cwd: '/var/log', exitCode: 0 },
      { commandLine: 'c', cwd: '/tmp', exitCode: 0 }, // dup
    ],
    '/home/u',
  )

  it('returns deduped recency-first dirs', () => {
    const src = new DirectoryHistorySource({ tracker })
    expect(src.list().map((e) => e.path)).toEqual(['/home/u', '/tmp', '/var/log'])
  })

  it('merges extras source', () => {
    const src = new DirectoryHistorySource({
      tracker,
      extras: { list: () => ['/old/project', '/var/log'] },
    })
    const r = src.list().map((e) => e.path)
    expect(r).toContain('/old/project')
    // extra dups against tracker also dedupe
    expect(r.filter((p) => p === '/var/log')).toHaveLength(1)
  })

  it('filter does fuzzy substring across paths', () => {
    const src = new DirectoryHistorySource({ tracker })
    expect(src.filter('var').map((e) => e.path)).toEqual(['/var/log'])
    expect(src.filter('tmp').map((e) => e.path)).toEqual(['/tmp'])
  })
})

// ─── trackerAdapter ──────────────────────────────────────────────

describe('trackerAdapter', () => {
  it('flattens one or more MinimalTrackers into a single adapter', () => {
    const t1: MinimalTracker = {
      snapshot: () => ({
        commands: [
          { commandLine: 'foo', cwd: '/a', exitCode: 0 },
          { commandLine: 'bar', cwd: '/b', exitCode: 1 },
        ],
        cwd: '/a',
      }),
    }
    const t2: MinimalTracker = {
      snapshot: () => ({
        commands: [{ commandLine: 'baz', cwd: '/c', exitCode: 0 }],
        cwd: '/c',
      }),
    }
    const adapter = trackerAdapter(t1, t2)
    expect(adapter.commandHistory().map((c) => c.commandLine)).toEqual(['foo', 'bar', 'baz'])
    expect(adapter.directoryHistory()).toEqual(['/a', '/b', '/a', '/c', '/c'])
  })

  it('drops empty commandLines', () => {
    const t: MinimalTracker = {
      snapshot: () => ({
        commands: [
          { commandLine: '   ', cwd: '/a', exitCode: 0 },
          { commandLine: 'echo', cwd: '/a', exitCode: 0 },
        ],
        cwd: null,
      }),
    }
    const adapter = trackerAdapter(t)
    expect(adapter.commandHistory().map((c) => c.commandLine)).toEqual(['echo'])
  })
})
