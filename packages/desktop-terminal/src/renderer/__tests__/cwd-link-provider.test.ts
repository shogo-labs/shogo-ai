// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  CwdLinkProvider,
  findLinksInRow,
  isAbsolutePath,
  joinPath,
  resolveCwdAtRow,
  tokeniseRow,
  type CommandWithCwd,
  type LinkMatch,
  type TrackerCwdLookup,
} from '../links/cwd-link-provider'

const tracker = (cmds: CommandWithCwd[], current: string | null = null): TrackerCwdLookup => ({
  listCommands: () => cmds,
  currentCwd: () => current,
})

// ─── path helpers ──────────────────────────────────────────────────

describe('isAbsolutePath', () => {
  it.each([
    ['/tmp/foo', true],
    ['~/Desktop', true],
    ['C:\\foo', true],
    ['c:/foo', true],
    ['\\\\server\\share', true],
    ['//server/share', true],
    ['foo.ts', false],
    ['src/foo.ts', false],
    ['./foo', false],
    ['../foo', false],
    ['', false],
  ])('handles %s → %s', (p, expected) => {
    expect(isAbsolutePath(p)).toBe(expected)
  })
})

describe('joinPath', () => {
  it('joins POSIX cwd + relative', () => {
    expect(joinPath('/tmp', 'foo')).toBe('/tmp/foo')
    expect(joinPath('/tmp/', 'foo')).toBe('/tmp/foo')
    expect(joinPath('/tmp', './foo')).toBe('/tmp/foo')
  })
  it('collapses ../ segments', () => {
    expect(joinPath('/tmp/a/b', '../c')).toBe('/tmp/a/c')
    expect(joinPath('/tmp/a', '../../b')).toBe('/b')
  })
  it('joins Windows cwd + relative with backslashes', () => {
    expect(joinPath('C:\\foo', 'bar')).toBe('C:\\foo\\bar')
    expect(joinPath('C:\\foo\\bar', '..\\baz')).toBe('C:\\foo\\baz')
  })
})

// ─── tokenise ──────────────────────────────────────────────────────

describe('tokeniseRow', () => {
  it('returns positioned tokens', () => {
    const t = tokeniseRow('hello  world')
    expect(t).toEqual([
      { text: 'hello', start: 0, end: 5 },
      { text: 'world', start: 7, end: 12 },
    ])
  })
  it('returns empty for whitespace-only rows', () => {
    expect(tokeniseRow('   ')).toEqual([])
  })
})

// ─── resolveCwdAtRow ──────────────────────────────────────────────

describe('resolveCwdAtRow', () => {
  it('returns the cwd of the latest command at-or-before the row', () => {
    const t = tracker([
      { id: 1, cwd: '/tmp', startLine: 5 },
      { id: 2, cwd: '/var/log', startLine: 12 },
      { id: 3, cwd: '/home/u', startLine: 20 },
    ])
    expect(resolveCwdAtRow(t, 4)).toBeNull() // before first command
    expect(resolveCwdAtRow(t, 5)).toBe('/tmp')
    expect(resolveCwdAtRow(t, 7)).toBe('/tmp')
    expect(resolveCwdAtRow(t, 12)).toBe('/var/log')
    expect(resolveCwdAtRow(t, 19)).toBe('/var/log')
    expect(resolveCwdAtRow(t, 21)).toBe('/home/u')
  })

  it('falls back to currentCwd when no commands cover the row', () => {
    const t = tracker([], '/home/u')
    expect(resolveCwdAtRow(t, 100)).toBe('/home/u')
  })

  it('skips commands with null startLine', () => {
    const t = tracker([
      { id: 1, cwd: '/tmp', startLine: null },
      { id: 2, cwd: '/var/log', startLine: 10 },
    ])
    expect(resolveCwdAtRow(t, 12)).toBe('/var/log')
    expect(resolveCwdAtRow(t, 5)).toBeNull()
  })
})

// ─── findLinksInRow ───────────────────────────────────────────────

describe('findLinksInRow — absolute paths', () => {
  const t = tracker([], '/home/u')

  it('matches POSIX absolute paths', () => {
    const m = findLinksInRow({ row: 'see /tmp/foo.txt for details', rowNumber: 0, tracker: t })
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ text: '/tmp/foo.txt', resolvedPath: '/tmp/foo.txt' })
  })

  it('matches Windows absolute paths', () => {
    const m = findLinksInRow({ row: 'open C:\\tmp\\foo.txt please', rowNumber: 0, tracker: t })
    expect(m).toHaveLength(1)
    expect(m[0]!.resolvedPath).toBe('C:\\tmp\\foo.txt')
  })

  it('captures line:col suffixes', () => {
    const m = findLinksInRow({ row: 'error /tmp/foo.ts:42:7 not found', rowNumber: 0, tracker: t })
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({
      text: '/tmp/foo.ts:42:7',
      resolvedPath: '/tmp/foo.ts',
      fileLine: 42,
      fileColumn: 7,
    })
  })

  it('captures line-only suffix', () => {
    const m = findLinksInRow({ row: 'see /tmp/foo.ts:42 fix it', rowNumber: 0, tracker: t })
    expect(m[0]!.fileLine).toBe(42)
    expect(m[0]!.fileColumn).toBeUndefined()
  })
})

describe('findLinksInRow — relative paths', () => {
  const t = tracker([
    { id: 1, cwd: '/tmp', startLine: 0 },
  ])

  it('resolves relative path against the row\'s cwd', () => {
    const m = findLinksInRow({ row: 'cat ./src/foo.ts', rowNumber: 0, tracker: t })
    expect(m).toHaveLength(1)
    expect(m[0]!.resolvedPath).toBe('/tmp/src/foo.ts')
  })

  it('matches bare file-with-extension tokens', () => {
    const m = findLinksInRow({ row: 'open package.json now', rowNumber: 0, tracker: t })
    expect(m[0]!.resolvedPath).toBe('/tmp/package.json')
  })

  it('drops relative-path matches when no cwd is known', () => {
    const tt = tracker([], null)
    const m = findLinksInRow({ row: 'open package.json', rowNumber: 0, tracker: tt })
    expect(m).toEqual([])
  })

  it('still emits absolute matches when no cwd is known', () => {
    const tt = tracker([], null)
    const m = findLinksInRow({ row: 'open /etc/hosts', rowNumber: 0, tracker: tt })
    expect(m).toHaveLength(1)
    expect(m[0]!.resolvedPath).toBe('/etc/hosts')
  })
})

describe('findLinksInRow — punctuation + boundaries', () => {
  const t = tracker([], '/tmp')

  it('strips trailing , ; ) etc from the match', () => {
    const m = findLinksInRow({ row: 'see /tmp/foo.txt, also /tmp/bar.txt.', rowNumber: 0, tracker: t })
    expect(m.map((x) => x.text)).toEqual(['/tmp/foo.txt', '/tmp/bar.txt'])
  })

  it('preserves the start column at the original token start', () => {
    const m = findLinksInRow({ row: 'see /tmp/foo.txt now', rowNumber: 0, tracker: t })
    expect(m[0]!.start).toBe(4)
    expect(m[0]!.end).toBe(16) // length of /tmp/foo.txt
  })

  it('rejects bare words without an extension or slash', () => {
    const m = findLinksInRow({ row: 'hello world', rowNumber: 0, tracker: t })
    expect(m).toEqual([])
  })

  it('rejects URLs (those should be handled by xterm\'s web-links addon)', () => {
    const m = findLinksInRow({ row: 'visit https://example.com today', rowNumber: 0, tracker: t })
    // We don't match URLs; ensure we don't match the scheme as a path.
    expect(m.find((x) => x.text.startsWith('http'))).toBeUndefined()
  })
})

// ─── provider integration ─────────────────────────────────────────

describe('CwdLinkProvider', () => {
  it('forwards provideLinks to the row scanner', () => {
    const t = tracker([{ id: 1, cwd: '/tmp', startLine: 0 }])
    const p = new CwdLinkProvider({ tracker: t, open: () => undefined })
    const matches = p.provideLinks('open package.json', 0)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.resolvedPath).toBe('/tmp/package.json')
  })

  it('honours the filter option', () => {
    const t = tracker([{ id: 1, cwd: '/tmp', startLine: 0 }])
    const p = new CwdLinkProvider({
      tracker: t,
      open: () => undefined,
      filter: (m) => !m.resolvedPath.includes('.git/'),
    })
    expect(p.provideLinks('open .git/config', 0).map((m) => m.text)).toEqual([])
    expect(p.provideLinks('open package.json', 0).map((m) => m.text)).toEqual(['package.json'])
  })

  it('activate() calls the open handler with event + match', () => {
    const t = tracker([], '/home/u')
    const calls: Array<{ ev: unknown; match: LinkMatch }> = []
    const p = new CwdLinkProvider({ tracker: t, open: (ev, m) => calls.push({ ev, match: m }) })
    const match = p.provideLinks('open /etc/hosts', 0)[0]!
    const fakeEvent = { button: 0 } as unknown as MouseEvent
    p.activate(fakeEvent, match)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.ev).toBe(fakeEvent)
    expect(calls[0]!.match.resolvedPath).toBe('/etc/hosts')
  })
})
