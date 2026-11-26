// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { MemProbe, type MemSample } from './mem-probe'

const MIB = 1024 * 1024

function probe(over: Partial<{ rss: number; heapUsed: number; external: number; arrayBuffers: number }> = {}) {
  const sample: MemSample = {
    rss: 40 * 1024 * MIB,
    heapUsed: 200 * MIB,
    external: 39 * 1024 * MIB,
    arrayBuffers: 38 * 1024 * MIB,
    ...over,
  }
  const lines: string[] = []
  const p = new MemProbe({
    thresholdBytes: 4096 * MIB,
    intervalMs: 1000,
    sample: () => sample,
    log: (line) => lines.push(line),
    now: () => 1_000_000,
  })
  return { p, lines, sample }
}

describe('MemProbe', () => {
  test('reports rss, the external/arrayBuffers split, and in-flight sites with sizes', () => {
    const { p } = probe()
    const a = p.begin('export:data', 'ws:proj:abc')
    p.end(a, 214 * MIB)
    const b = p.begin('snapshot:push', 'ws:proj:def')
    const c = p.begin('export:source', 'fcvm-1')
    p.end(c, 3 * MIB)

    const line = p.line()

    expect(line).toContain('[mem]')
    expect(line).toContain('rss=40960MiB')
    expect(line).toContain('external=39936MiB')
    expect(line).toContain('arrayBuffers=38912MiB')
    // The stream upload has no known length; that is exactly the shape worth seeing.
    expect(line).toContain('by_kind=snapshot:push:1')
    expect(line).toContain('snapshot:push(unknown')
    p.end(b, 900 * MIB)
    expect(p.count()).toBe(0)
  })

  test('tick only logs above the threshold', () => {
    const { p, lines } = probe({ rss: 1024 * MIB })
    p.tick()
    expect(lines).toEqual([])

    const big = probe()
    big.p.tick()
    expect(big.lines.length).toBe(1)
    expect(big.lines[0]).toContain('rss=40960MiB')
  })

  test('peak survives a drop, so the high-water mark is not lost between samples', () => {
    let rss = 30 * 1024 * MIB
    const p = new MemProbe({ thresholdBytes: 0, intervalMs: 1000, sample: () => ({ rss, heapUsed: 0, external: 0, arrayBuffers: 0 }) })
    p.tick()
    rss = 300 * MIB
    p.tick()
    expect(p.peakRss).toBe(30 * 1024 * MIB)
    expect(p.line()).toContain('peak=30720MiB')
  })

  test('sites are ordered largest first so the log leads with the culprit', () => {
    const { p } = probe()
    const small = p.begin('export:home', 'a')
    p.held(small, 1 * MIB)
    const big = p.begin('archive:load', 'b')
    p.held(big, 1800 * MIB)
    const open = p.begin('export:data', 'c')

    expect(p.inFlight().map((s) => s.label)).toEqual(['b', 'a', 'c'])

    // What the line shows for a stream of no known length, and that `held` is
    // what makes an in-flight size visible at all.
    const line = p.line()
    expect(line).toContain('archive:load(1800MiB')
    expect(line).toContain('export:data(unknown')
    p.end(open)
  })
})
