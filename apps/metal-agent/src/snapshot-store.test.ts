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
import { createSnapshotStore, downloadRanged, pumpStream, type RangeFetcher } from './snapshot-store'
import { mkdirSync, writeFileSync } from 'fs'

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


/**
 * Why a durable pull missed (SHO-271). Every miss used to be labelled
 * `stale_reason=rootfs`, which inflated the measured post-release cold-boot wave
 * (2,250 US boots in 14 days) and sent rewarm tuning after the wrong cause.
 */
describe('missReason', () => {
  const store = () =>
    createSnapshotStore({
      snapStore: 'fs',
      snapStoreDir: dir,
      snapStorePrefix: 'snap',
      snapSlim: false,
      snapBasePrefix: 'bases/',
    } as any)

  const writeMeta = (projectId: string, meta: Record<string, unknown>) => {
    const d = join(dir, 'snap', projectId)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'meta.json'), JSON.stringify({ projectId, ...meta }))
  }

  test('absent when the project has no durable snapshot at all', async () => {
    expect(await store().missReason!('p1', 'sz1-mt2')).toBe('absent')
  })

  test('rootfs when the snapshot was taken on a different golden image', async () => {
    writeMeta('p1', { rootfsIdentity: 'sz1-mt1' })
    expect(await store().missReason!('p1', 'sz1-mt2')).toBe('rootfs')
  })

  test('absent (not rootfs) when the identity matches but the pull still missed', async () => {
    writeMeta('p1', { rootfsIdentity: 'sz1-mt2' })
    expect(await store().missReason!('p1', 'sz1-mt2')).toBe('absent')
  })
})

/**
 * The snapshot push used to hand S3 a `Response` with a gzip stream body, which
 * Bun read whole before uploading (measured on staging: 4.1 GiB of
 * `arrayBuffers` for one 4 GiB VM, for over 100 s). `pumpStream` is the
 * replacement, so these tests pin the two properties that make it bounded:
 * writes are awaited (backpressure, so the sink cannot accumulate) and nothing
 * ever materialises the stream.
 */
describe('pumpStream (bounded snapshot upload)', () => {
  /** A ReadableStream of `chunks` × `chunkBytes`, generated lazily — never built up front. */
  function synthetic(totalBytes: number, chunkBytes: number): ReadableStream<Uint8Array> {
    let sent = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) return controller.close()
        const size = Math.min(chunkBytes, totalBytes - sent)
        const chunk = new Uint8Array(size)
        chunk.fill(sent & 0xff)
        sent += size
        controller.enqueue(chunk)
      },
    })
  }

  test('awaits each write, so a slow sink never has two chunks outstanding', async () => {
    let outstanding = 0
    let maxOutstanding = 0
    const order: number[] = []
    const sink = {
      write(chunk: Uint8Array) {
        outstanding++
        maxOutstanding = Math.max(maxOutstanding, outstanding)
        order.push(chunk[0])
        // A sink that cannot take the bytes yet returns a promise; a caller that
        // fired without awaiting would put `outstanding` at the chunk count.
        return new Promise<number>((resolve) =>
          setTimeout(() => {
            outstanding--
            resolve(chunk.byteLength)
          }, 1),
        )
      },
      end() {
        return 0
      },
    }

    const moved = await pumpStream(synthetic(64 * 1024, 1024), sink)

    expect(moved).toBe(64 * 1024)
    expect(maxOutstanding).toBe(1)
    expect(order.length).toBe(64)
  })

  test('moves 512 MiB through without the agent holding it', async () => {
    const MIB = 1024 * 1024
    const total = 512 * MIB
    let sinkBytes = 0
    let peakChunk = 0
    const sink = {
      write(chunk: Uint8Array) {
        sinkBytes += chunk.byteLength
        peakChunk = Math.max(peakChunk, chunk.byteLength)
        return chunk.byteLength // "already flushed": nothing retained
      },
      end() {
        return 0
      },
    }

    const before = process.memoryUsage().arrayBuffers
    let peakArrayBuffers = before
    const poll = setInterval(() => {
      peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers)
    }, 5)
    let moved = 0
    try {
      moved = await pumpStream(synthetic(total, 1 * MIB), sink)
    } finally {
      clearInterval(poll)
    }

    expect(moved).toBe(total)
    expect(sinkBytes).toBe(total)
    expect(peakChunk).toBe(1 * MIB)
    // The old shape would show ~512 MiB here. Anything at or under one chunk is
    // the generator's own chunk; a part's worth (16 MiB) is the ceiling we allow.
    expect(peakArrayBuffers - before).toBeLessThan(16 * MIB)
  })
})
