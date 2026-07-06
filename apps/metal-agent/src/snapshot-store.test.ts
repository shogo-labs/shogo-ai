// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the storage-agnostic parallel ranged GET (downloadRanged).
 *
 * The real S3 wiring (Bun S3Client.slice().arrayBuffer()) is exercised e2e on
 * the bare-metal host; here we drive the offset math, byte-range coverage,
 * concurrency cap, reassembly and error handling with an in-memory RangeFetcher
 * so the algorithm is provable without a network/S3 dependency.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { downloadRanged, type RangeFetcher } from './snapshot-store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapstore-ranged-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Deterministic source buffer so reassembly can be byte-compared. */
function makeSource(size: number): Uint8Array {
  const src = new Uint8Array(size)
  for (let i = 0; i < size; i++) src[i] = (i * 31 + 7) & 0xff
  return src
}

/** A RangeFetcher backed by an in-memory buffer that also records call spans. */
function fetcherFor(
  src: Uint8Array,
  calls: Array<[number, number]>,
  track?: { inFlight: number; max: number },
): RangeFetcher {
  return async (start, end) => {
    calls.push([start, end])
    if (track) {
      track.inFlight++
      track.max = Math.max(track.max, track.inFlight)
    }
    // Defer a tick so overlapping lanes actually overlap for the cap assertion.
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 1))
    if (track) track.inFlight--
    return src.subarray(start, end)
  }
}

describe('downloadRanged', () => {
  test('reassembles an object that splits evenly into parts', async () => {
    const src = makeSource(64)
    const calls: Array<[number, number]> = []
    const dest = join(dir, 'even.bin')
    await downloadRanged(dest, src.length, fetcherFor(src, calls), { partBytes: 16, concurrency: 4 })
    expect(new Uint8Array(readFileSync(dest))).toEqual(src)
    expect(calls.length).toBe(4)
  })

  test('reassembles an object with a short trailing part', async () => {
    const src = makeSource(70) // 16*4 = 64, last part is 6 bytes
    const calls: Array<[number, number]> = []
    const dest = join(dir, 'odd.bin')
    await downloadRanged(dest, src.length, fetcherFor(src, calls), { partBytes: 16, concurrency: 3 })
    expect(new Uint8Array(readFileSync(dest))).toEqual(src)
    expect(calls.length).toBe(5)
    // Full, gapless, non-overlapping coverage with end-exclusive spans.
    const sorted = [...calls].sort((a, b) => a[0] - b[0])
    expect(sorted[0][0]).toBe(0)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i][0]).toBe(sorted[i - 1][1])
    expect(sorted.at(-1)![1]).toBe(src.length)
  })

  test('single part when object <= partBytes', async () => {
    const src = makeSource(10)
    const calls: Array<[number, number]> = []
    const dest = join(dir, 'small.bin')
    await downloadRanged(dest, src.length, fetcherFor(src, calls), { partBytes: 16, concurrency: 8 })
    expect(new Uint8Array(readFileSync(dest))).toEqual(src)
    expect(calls).toEqual([[0, 10]])
  })

  test('writes a zero-byte file for an empty object without fetching', async () => {
    const calls: Array<[number, number]> = []
    const dest = join(dir, 'empty.bin')
    await downloadRanged(dest, 0, fetcherFor(new Uint8Array(0), calls), { partBytes: 16, concurrency: 4 })
    expect(readFileSync(dest).length).toBe(0)
    expect(calls.length).toBe(0)
  })

  test('never exceeds the configured concurrency', async () => {
    const src = makeSource(16 * 20) // 20 parts
    const calls: Array<[number, number]> = []
    const track = { inFlight: 0, max: 0 }
    const dest = join(dir, 'cap.bin')
    await downloadRanged(dest, src.length, fetcherFor(src, calls, track), { partBytes: 16, concurrency: 5 })
    expect(new Uint8Array(readFileSync(dest))).toEqual(src)
    expect(calls.length).toBe(20)
    expect(track.max).toBeLessThanOrEqual(5)
    expect(track.max).toBe(5) // lanes should actually saturate
  })

  test('caps lanes at the part count when concurrency exceeds parts', async () => {
    const src = makeSource(20) // 2 parts at partBytes 16
    const calls: Array<[number, number]> = []
    const track = { inFlight: 0, max: 0 }
    const dest = join(dir, 'fewparts.bin')
    await downloadRanged(dest, src.length, fetcherFor(src, calls, track), { partBytes: 16, concurrency: 8 })
    expect(new Uint8Array(readFileSync(dest))).toEqual(src)
    expect(track.max).toBeLessThanOrEqual(2)
  })

  test('throws on a short read rather than writing a torn file', async () => {
    const src = makeSource(64)
    const bad: RangeFetcher = async (start, end) => src.subarray(start, Math.max(start, end - 1))
    const dest = join(dir, 'short.bin')
    await expect(
      downloadRanged(dest, src.length, bad, { partBytes: 16, concurrency: 4 }),
    ).rejects.toThrow(/short read/)
  })

  test('treats partBytes <= 0 as a single-byte floor (never divides by zero)', async () => {
    const src = makeSource(3)
    const calls: Array<[number, number]> = []
    const dest = join(dir, 'floor.bin')
    await downloadRanged(dest, src.length, fetcherFor(src, calls), { partBytes: 0, concurrency: 2 })
    expect(new Uint8Array(readFileSync(dest))).toEqual(src)
    expect(calls.length).toBe(3) // one part per byte
  })
})
