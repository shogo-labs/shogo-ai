// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stability of the observer's answer (SHO-200).
 *
 * The desktop Preview tab re-opens whenever `detectedUrl` goes null → non-null,
 * so the observer's output has to be stable across the things that are normal
 * while a dev server runs: one slow HEAD probe, a second listener appearing or
 * disappearing, a listener that isn't the app at all.
 *
 * Run: bun test apps/api/src/lib/port-observer/__tests__/local-port-observer-stability.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  LocalPortObserver,
  type FolderResolver,
  type HttpProbe,
  type ListeningSocket,
  type PortScanner,
  type ProcessInfo,
} from '../local-port-observer'

interface MockScanner extends PortScanner {
  listings: ListeningSocket[]
  processes: Record<number, ProcessInfo | null>
  probeOk: Record<number, boolean>
  listCalls: number
}

function makeScanner(
  listings: ListeningSocket[],
  processes: Record<number, ProcessInfo | null>,
  probeOk: Record<number, boolean>,
): MockScanner {
  const m: MockScanner = {
    listings,
    processes,
    probeOk,
    listCalls: 0,
    async listListeningSockets() {
      this.listCalls += 1
      return this.listings
    },
    async describeProcess(pid: number) {
      return this.processes[pid] ?? null
    },
  }
  return m
}

function probeFor(scanner: MockScanner): HttpProbe {
  return {
    async probe(url: string) {
      const match = url.match(/:(\d+)$/)
      if (!match) return false
      return scanner.probeOk[Number(match[1])] ?? false
    },
  }
}

const FOLDERS: FolderResolver = {
  async resolveFolders() {
    return ['/Users/me/app']
  },
}

const START = 1_700_000_000_000

function makeObserver(scanner: MockScanner) {
  const clock = { now: START }
  const observer = new LocalPortObserver({
    scanner,
    httpProbe: probeFor(scanner),
    folderResolver: FOLDERS,
    now: () => clock.now,
    scanThrottleMs: 0,
    internalPids: () => new Set([4242]),
  })
  /** Advance past the scan throttle and take one observation. */
  const tick = async (projectId = 'p1') => {
    const out = await observer.attributedPorts(projectId)
    clock.now += 5_000
    return out
  }
  return { observer, clock, tick }
}

const DEV_SERVER: ListeningSocket = { pid: 1, port: 5173, command: 'node', address: '127.0.0.1' }
const API_SERVER: ListeningSocket = { pid: 2, port: 3001, command: 'node', address: '127.0.0.1' }
const PROCESSES: Record<number, ProcessInfo | null> = {
  1: { pid: 1, cwd: '/Users/me/app' },
  2: { pid: 2, cwd: '/Users/me/app' },
}

describe('S2 — one missed probe is not the server going away', () => {
  test('the port survives a scan where the probe failed', async () => {
    const scanner = makeScanner([DEV_SERVER], PROCESSES, { 5173: true })
    const { tick } = makeObserver(scanner)

    expect((await tick()).map((p) => p.url)).toEqual(['http://127.0.0.1:5173'])

    // The server is compiling and misses the HEAD probe once.
    scanner.probeOk[5173] = false
    expect((await tick()).map((p) => p.url)).toEqual(['http://127.0.0.1:5173'])

    scanner.probeOk[5173] = true
    expect((await tick()).map((p) => p.url)).toEqual(['http://127.0.0.1:5173'])
  })

  test('the port survives a scan where the socket disappeared entirely', async () => {
    const scanner = makeScanner([DEV_SERVER], PROCESSES, { 5173: true })
    const { tick } = makeObserver(scanner)

    expect((await tick()).map((p) => p.url)).toEqual(['http://127.0.0.1:5173'])

    // Restart gap: the socket is gone for one poll.
    scanner.listings = []
    expect((await tick()).map((p) => p.url)).toEqual(['http://127.0.0.1:5173'])

    scanner.listings = [DEV_SERVER]
    const out = await tick()
    expect(out.map((p) => p.url)).toEqual(['http://127.0.0.1:5173'])
    // …and it is reported as freshly seen again.
    expect(out[0].observedAt).toBe(START + 10_000)
  })

  test('a port that is really gone is dropped once the grace window passes', async () => {
    const scanner = makeScanner([DEV_SERVER], PROCESSES, { 5173: true })
    const { tick } = makeObserver(scanner)
    await tick()
    scanner.listings = []
    expect(await tick()).toHaveLength(1) // one missed scan: remembered
    expect(await tick()).toHaveLength(0) // two real scans in a row: gone
  })
})

describe('S3 — a second server cannot steal the answer', () => {
  test('a lower-numbered port appearing later does not take over', async () => {
    const scanner = makeScanner([DEV_SERVER], PROCESSES, { 5173: true, 3001: true })
    const { tick } = makeObserver(scanner)

    expect((await tick()).map((p) => p.url)).toEqual(['http://127.0.0.1:5173'])

    // An API server starts on the lower port. Port-ascending order would pick
    // it; stickiness must not.
    scanner.listings = [DEV_SERVER, API_SERVER]
    expect((await tick()).map((p) => p.url)).toEqual([
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3001',
    ])

    // …and it still leads when the second server goes away and comes back.
    scanner.listings = [DEV_SERVER]
    expect((await tick())[0].url).toBe('http://127.0.0.1:5173')
    scanner.listings = [DEV_SERVER, API_SERVER]
    expect((await tick())[0].url).toBe('http://127.0.0.1:5173')
  })

  test('detectedUrl is the sticky pick, not a fresh ranking', async () => {
    const scanner = makeScanner([{ ...DEV_SERVER, port: 3001 }], PROCESSES, {
      3001: true,
      5173: true,
    })
    const { observer, tick } = makeObserver(scanner)
    await tick()
    scanner.listings = [{ ...DEV_SERVER, port: 3001 }, DEV_SERVER]
    expect(await observer.detectedUrl('p1')).toBe('http://127.0.0.1:3001')
  })

  test('memory is per project — one project cannot keep another’s port alive', async () => {
    const scanner = makeScanner([DEV_SERVER], PROCESSES, { 5173: true })
    const { tick } = makeObserver(scanner)
    await tick('p1')
    scanner.listings = []
    const other = await tick('p2')
    expect(other).toEqual([])
  })
})

describe('B.3 — listeners that are not the app are skipped', () => {
  test('skips the Node inspector port', async () => {
    const scanner = makeScanner(
      [{ pid: 1, port: 9229, command: 'node', address: '127.0.0.1' }, DEV_SERVER],
      PROCESSES,
      { 9229: true, 5173: true },
    )
    const { tick } = makeObserver(scanner)
    expect((await tick()).map((p) => p.port)).toEqual([5173])
  })

  test('skips this API process and anything it spawned', async () => {
    const children: ListeningSocket[] = [
      { pid: 4242, port: 8080, command: 'bun', address: '127.0.0.1' }, // the API itself
      { pid: 5000, port: 8081, command: 'bun', address: '127.0.0.1' }, // a child of it
    ]
    const scanner = makeScanner(children, {
      ...PROCESSES,
      4242: { pid: 4242, cwd: '/Users/me/app', ppid: 1 },
      5000: { pid: 5000, cwd: '/Users/me/app', ppid: 4242 },
    }, { 8080: true, 8081: true })
    const { tick } = makeObserver(scanner)
    expect(await tick()).toEqual([])
  })

  test('a grandchild of the API is skipped too', async () => {
    const scanner = makeScanner(
      [{ pid: 6000, port: 8082, command: 'bun', address: '127.0.0.1' }],
      { 6000: { pid: 6000, cwd: '/Users/me/app', ppid: 7000 }, 7000: { pid: 7000, cwd: '/Users/me/app', ppid: 4242 } },
      { 8082: true },
    )
    const { tick } = makeObserver(scanner)
    expect(await tick()).toEqual([])
  })

  test('a normal dev server is still attributed', async () => {
    const scanner = makeScanner([DEV_SERVER], { 1: { pid: 1, cwd: '/Users/me/app', ppid: 999 } }, {
      5173: true,
    })
    const { tick } = makeObserver(scanner)
    expect((await tick()).map((p) => p.port)).toEqual([5173])
  })
})
