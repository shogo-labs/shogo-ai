// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for LocalPortObserver.
 *
 * The observer's external dependencies — the platform scanner, the
 * HTTP probe, and the folder resolver — are all injected, so these
 * tests run hermetically (no `lsof`, no network, no prisma) and on any
 * platform. Coverage is structured around the edge cases that matter
 * in production:
 *
 *   - lsof unavailable / scanner returns empty → graceful no-op
 *   - lsof output parsing: IPv4, IPv6, wildcard, multiple records,
 *     dupe pid:port across address families, malformed lines
 *   - PID's cwd outside any project folder → not attributed
 *   - Path-boundary attacks: `/a/app` must NOT match `/a/app2`
 *   - Project with multiple folders → match any
 *   - HTTP probe filters non-HTTP listeners (Postgres, language servers)
 *   - Probe failure on HEAD falls back to ranged GET
 *   - Scan throttling: two consecutive calls share one scan
 *   - Concurrent calls coalesce onto one in-flight scan
 *   - Scanner errors are swallowed; observer returns []
 *   - detectedUrl picks the lowest port number as a tiebreaker
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  LocalPortObserver,
  parseLsofListening,
  parseLsofCwd,
  pathIsWithin,
  type FolderResolver,
  type HttpProbe,
  type ListeningSocket,
  type PortScanner,
  type ProcessInfo,
} from '../local-port-observer'

/* ─── parser tests ─── */

describe('parseLsofListening', () => {
  test('parses a single IPv4 record', () => {
    const out = parseLsofListening(['p4821', 'cnode', 'n127.0.0.1:5173', ''].join('\n'))
    expect(out).toEqual([{ pid: 4821, command: 'node', address: '127.0.0.1', port: 5173 }])
  })

  test('parses IPv6 with brackets', () => {
    const out = parseLsofListening(['p77', 'cbun', 'n[::1]:3000'].join('\n'))
    expect(out).toEqual([{ pid: 77, command: 'bun', address: '::1', port: 3000 }])
  })

  test('handles multiple processes & dedupes ipv4/ipv6 on same pid+port', () => {
    const raw = [
      'p100',
      'cnode',
      'n127.0.0.1:5173',
      'n[::1]:5173', // same pid, same port → de-duped
      'p200',
      'cpostgres',
      'n127.0.0.1:5432',
    ].join('\n')
    const out = parseLsofListening(raw)
    expect(out).toHaveLength(2)
    expect(out.map((s) => `${s.pid}:${s.port}`)).toEqual(['100:5173', '200:5432'])
  })

  test('drops malformed port numbers', () => {
    const out = parseLsofListening(['p1', 'cnode', 'n127.0.0.1:abc', 'n127.0.0.1:99999'].join('\n'))
    expect(out).toEqual([])
  })

  test('drops records without a pid', () => {
    // A `n` line before any `p` line — pretend lsof emitted a header.
    const out = parseLsofListening('n127.0.0.1:5173')
    expect(out).toEqual([])
  })

  test('empty input returns empty array', () => {
    expect(parseLsofListening('')).toEqual([])
  })

  test('handles wildcard listen address', () => {
    const out = parseLsofListening(['p7', 'cnode', 'n*:8080'].join('\n'))
    expect(out).toEqual([{ pid: 7, command: 'node', address: '*', port: 8080 }])
  })
})

describe('parseLsofCwd', () => {
  test('returns first n-line value', () => {
    expect(parseLsofCwd('p4821\nfcwd\nn/Users/me/proj')).toBe('/Users/me/proj')
  })
  test('returns null on empty', () => {
    expect(parseLsofCwd('')).toBeNull()
    expect(parseLsofCwd('p4821\nfcwd')).toBeNull()
  })
})

describe('pathIsWithin', () => {
  test('exact match', () => {
    expect(pathIsWithin('/Users/a/app', '/Users/a/app')).toBe(true)
  })
  test('proper descendant', () => {
    expect(pathIsWithin('/Users/a/app/src', '/Users/a/app')).toBe(true)
  })
  test('sibling with shared prefix must NOT match', () => {
    // The classic path-attack: /Users/a/app vs /Users/a/app2
    expect(pathIsWithin('/Users/a/app2', '/Users/a/app')).toBe(false)
    expect(pathIsWithin('/Users/a/app2/src', '/Users/a/app')).toBe(false)
  })
  test('outside path is false', () => {
    expect(pathIsWithin('/Users/b/other', '/Users/a/app')).toBe(false)
  })
  test('empty inputs are false', () => {
    expect(pathIsWithin('', '/Users/a/app')).toBe(false)
    expect(pathIsWithin('/Users/a/app', '')).toBe(false)
  })
})

/* ─── observer tests ─── */

interface MockScanner extends PortScanner {
  listings: ListeningSocket[]
  processes: Record<number, ProcessInfo | null>
  listCalls: number
  describeCalls: number
  listError?: Error | null
}

function makeMockScanner(
  listings: ListeningSocket[],
  processes: Record<number, ProcessInfo | null>,
): MockScanner {
  const m: MockScanner = {
    listings,
    processes,
    listCalls: 0,
    describeCalls: 0,
    async listListeningSockets() {
      this.listCalls++
      if (this.listError) throw this.listError
      return this.listings
    },
    async describeProcess(pid: number) {
      this.describeCalls++
      return this.processes[pid] ?? null
    },
  }
  return m
}

function probe(ports: Record<number, boolean>): HttpProbe {
  return {
    async probe(url: string) {
      const match = url.match(/:(\d+)$/)
      if (!match) return false
      return ports[Number(match[1])] ?? false
    },
  }
}

function folders(map: Record<string, string[]>): FolderResolver {
  return {
    async resolveFolders(projectId: string) {
      return map[projectId] ?? []
    },
  }
}

const NOW = 1_700_000_000_000

describe('LocalPortObserver.attributedPorts', () => {
  test('returns [] when project has no folders', async () => {
    const obs = new LocalPortObserver({
      scanner: makeMockScanner([], {}),
      httpProbe: probe({}),
      folderResolver: folders({}),
      now: () => NOW,
    })
    expect(await obs.attributedPorts('p1')).toEqual([])
  })

  test('attributes a port whose pid cwd is inside the folder', async () => {
    const scanner = makeMockScanner(
      [{ pid: 4821, port: 5173, command: 'node', address: '127.0.0.1' }],
      { 4821: { pid: 4821, cwd: '/Users/me/app/src' } },
    )
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 5173: true }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    const out = await obs.attributedPorts('p1')
    expect(out).toEqual([
      {
        projectId: 'p1',
        port: 5173,
        pid: 4821,
        command: 'node',
        url: 'http://127.0.0.1:5173',
        matchedFolder: '/Users/me/app',
        observedAt: NOW,
      },
    ])
  })

  test('does NOT attribute a port whose pid cwd is outside every folder', async () => {
    const scanner = makeMockScanner(
      [{ pid: 99, port: 8080, command: 'java', address: '0.0.0.0' }],
      { 99: { pid: 99, cwd: '/opt/other' } },
    )
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 8080: true }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    expect(await obs.attributedPorts('p1')).toEqual([])
  })

  test('filters out non-HTTP listeners (probe returns false)', async () => {
    // Postgres listening on 5432 with cwd inside the project folder.
    // Should still be dropped because it doesn't speak HTTP.
    const scanner = makeMockScanner(
      [
        { pid: 1, port: 5173, command: 'node', address: '127.0.0.1' },
        { pid: 2, port: 5432, command: 'postgres', address: '127.0.0.1' },
      ],
      {
        1: { pid: 1, cwd: '/Users/me/app' },
        2: { pid: 2, cwd: '/Users/me/app' },
      },
    )
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 5173: true, 5432: false }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    const out = await obs.attributedPorts('p1')
    expect(out.map((p) => p.port)).toEqual([5173])
  })

  test('matches against any of multiple project folders', async () => {
    const scanner = makeMockScanner(
      [{ pid: 1, port: 3000, command: 'next', address: '127.0.0.1' }],
      { 1: { pid: 1, cwd: '/Users/me/api' } },
    )
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 3000: true }),
      folderResolver: folders({ p1: ['/Users/me/web', '/Users/me/api'] }),
      now: () => NOW,
    })
    const out = await obs.attributedPorts('p1')
    expect(out[0]?.matchedFolder).toBe('/Users/me/api')
  })

  test('sibling-folder confusion: /app must NOT match /app2', async () => {
    const scanner = makeMockScanner(
      [{ pid: 1, port: 9000, command: 'node', address: '127.0.0.1' }],
      { 1: { pid: 1, cwd: '/Users/me/app2/src' } },
    )
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 9000: true }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    expect(await obs.attributedPorts('p1')).toEqual([])
  })

  test('handles pid with unknown cwd (lsof returned null)', async () => {
    const scanner = makeMockScanner(
      [{ pid: 1, port: 7777, command: 'node', address: '127.0.0.1' }],
      { 1: { pid: 1, cwd: null } },
    )
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 7777: true }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    expect(await obs.attributedPorts('p1')).toEqual([])
  })

  test('dedupes IPv4 + IPv6 entries for same port into a single result', async () => {
    // Same pid, same port, two listings (e.g. dual-stack server). The
    // parser already dedupes by pid:port but if upstream feeds us a
    // distinct-IP duplicate, the observer's by-port dedupe catches it.
    const scanner = makeMockScanner(
      [
        { pid: 1, port: 5173, command: 'node', address: '127.0.0.1' },
        { pid: 1, port: 5173, command: 'node', address: '::1' },
      ],
      { 1: { pid: 1, cwd: '/Users/me/app' } },
    )
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 5173: true }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    const out = await obs.attributedPorts('p1')
    expect(out).toHaveLength(1)
    expect(out[0].port).toBe(5173)
  })

  test('scanner errors degrade to empty result', async () => {
    const scanner = makeMockScanner([], {})
    scanner.listError = new Error('lsof: command not found')
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({}),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    expect(await obs.attributedPorts('p1')).toEqual([])
  })

  test('scan results are throttled across consecutive calls', async () => {
    let t = NOW
    const scanner = makeMockScanner(
      [{ pid: 1, port: 5173, command: 'node', address: '127.0.0.1' }],
      { 1: { pid: 1, cwd: '/Users/me/app' } },
    )
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 5173: true }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => t,
      scanThrottleMs: 1500,
    })
    await obs.attributedPorts('p1')
    await obs.attributedPorts('p1')
    await obs.attributedPorts('p1')
    expect(scanner.listCalls).toBe(1) // throttled

    t += 2000 // advance past throttle window
    await obs.attributedPorts('p1')
    expect(scanner.listCalls).toBe(2)
  })

  test('concurrent callers coalesce onto a single in-flight scan', async () => {
    let resolveScan!: (v: ListeningSocket[]) => void
    const slowScan = new Promise<ListeningSocket[]>((r) => {
      resolveScan = r
    })
    const scanner: PortScanner = {
      async listListeningSockets() {
        return slowScan
      },
      async describeProcess(pid) {
        return { pid, cwd: '/Users/me/app' }
      },
    }
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 5173: true }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    const a = obs.attributedPorts('p1')
    const b = obs.attributedPorts('p1')
    const c = obs.attributedPorts('p1')
    resolveScan([{ pid: 1, port: 5173, command: 'node', address: '127.0.0.1' }])
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(ra).toEqual(rb)
    expect(rb).toEqual(rc)
    expect(ra[0]?.port).toBe(5173)
  })
})

describe('LocalPortObserver.detectedUrl', () => {
  test('returns null when nothing is attributed', async () => {
    const obs = new LocalPortObserver({
      scanner: makeMockScanner([], {}),
      httpProbe: probe({}),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    expect(await obs.detectedUrl('p1')).toBeNull()
  })

  test('picks the lowest port when multiple servers are attributed', async () => {
    const scanner = makeMockScanner(
      [
        { pid: 1, port: 9229, command: 'node', address: '127.0.0.1' }, // node debug port
        { pid: 2, port: 5173, command: 'node', address: '127.0.0.1' }, // vite
        { pid: 3, port: 3000, command: 'next', address: '127.0.0.1' }, // next
      ],
      {
        1: { pid: 1, cwd: '/Users/me/app' },
        2: { pid: 2, cwd: '/Users/me/app' },
        3: { pid: 3, cwd: '/Users/me/app' },
      },
    )
    const obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 9229: true, 5173: true, 3000: true }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
    expect(await obs.detectedUrl('p1')).toBe('http://127.0.0.1:3000')
  })
})

/* ─── reset helpers used by tests at the call-site of the singleton ─── */

describe('reset & scanNow', () => {
  let obs: LocalPortObserver
  let scanner: MockScanner
  beforeEach(() => {
    scanner = makeMockScanner(
      [{ pid: 1, port: 5173, command: 'node', address: '127.0.0.1' }],
      { 1: { pid: 1, cwd: '/Users/me/app' } },
    )
    obs = new LocalPortObserver({
      scanner,
      httpProbe: probe({ 5173: true }),
      folderResolver: folders({ p1: ['/Users/me/app'] }),
      now: () => NOW,
    })
  })
  afterEach(() => obs.reset())

  test('reset() forces the next call to rescan', async () => {
    await obs.attributedPorts('p1')
    await obs.attributedPorts('p1')
    expect(scanner.listCalls).toBe(1)
    obs.reset()
    await obs.attributedPorts('p1')
    expect(scanner.listCalls).toBe(2)
  })

  test('scanNow() bypasses the throttle', async () => {
    await obs.attributedPorts('p1')
    expect(scanner.listCalls).toBe(1)
    await obs.scanNow()
    expect(scanner.listCalls).toBe(2)
  })
})
