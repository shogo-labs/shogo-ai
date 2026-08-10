// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The ordered parallel reader behind cold-boot hydrate.
 *
 * Two properties matter and neither is visible from a happy-path read: the
 * bytes must come out in order however the parts complete (an archive spliced
 * out of order extracts as garbage), and the read-ahead must stay inside its
 * window however slowly the consumer reads (an unbounded window would hold a
 * multi-gigabyte archive in the host's memory, which is the failure that made
 * the guest pull directly from S3 in the first place).
 */

import { describe, expect, test } from 'bun:test'

import { rangedStream } from './ranged-stream'

/** Byte at absolute offset `i` — lets any slice be checked against its offset. */
const byteAt = (i: number) => i % 251

function objectOf(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => byteAt(i))
}

async function collect(rs: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = rs.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value!)
    total += value!.length
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

describe('rangedStream', () => {
  test('reassembles in order even when later parts arrive first', async () => {
    const obj = objectOf(1000)
    // Invert the delays: the last part resolves first, the first part last. If
    // the reader emitted on completion rather than by offset, this is the case
    // that would silently produce a scrambled archive.
    const parts = Math.ceil(1000 / 100)
    const fetchRange = async (s: number, e: number) => {
      await tick((parts - Math.floor(s / 100)) * 5)
      return obj.slice(s, e)
    }
    const got = await collect(rangedStream(1000, fetchRange, { partBytes: 100, concurrency: 4 }))
    expect(got).toEqual(obj)
  })

  test('requests every byte exactly once, in whole parts', async () => {
    const seen: Array<[number, number]> = []
    const obj = objectOf(1050)
    const fetchRange = async (s: number, e: number) => {
      seen.push([s, e])
      return obj.slice(s, e)
    }
    await collect(rangedStream(1050, fetchRange, { partBytes: 100, concurrency: 3 }))

    seen.sort((a, b) => a[0] - b[0])
    expect(seen[0][0]).toBe(0)
    expect(seen.at(-1)![1]).toBe(1050) // the short tail part is not rounded up
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBe(seen[i - 1][1]) // contiguous, no overlap
  })

  test('never has more than `concurrency` fetches in flight', async () => {
    let live = 0
    let peak = 0
    const obj = objectOf(10_000)
    const fetchRange = async (s: number, e: number) => {
      live++
      peak = Math.max(peak, live)
      await tick(1)
      live--
      return obj.slice(s, e)
    }
    await collect(rangedStream(10_000, fetchRange, { partBytes: 100, concurrency: 5 }))
    expect(peak).toBe(5)
  })

  test('a consumer that stops reading stops the fetching', async () => {
    // The memory bound is only real if it holds against a slow reader: `tar`
    // extracting onto the guest's disk is slower than the network, which is
    // exactly the mismatch that OOM-killed the guest when the host pushed.
    let started = 0
    const obj = objectOf(100_000)
    const fetchRange = async (s: number, e: number) => {
      started++
      return obj.slice(s, e)
    }
    const rs = rangedStream(100_000, fetchRange, { partBytes: 1000, concurrency: 4 })
    const reader = rs.getReader()

    await reader.read() // take one part, then go quiet
    await tick(20)

    // Four in the window, plus two more the stream pulls to fill its own
    // one-chunk queue and the slot that frees behind it. The number that
    // matters is that it stops there and not at 100: read-ahead is a function
    // of the window, not of how big the object is.
    expect(started).toBe(6)
    await reader.cancel()
  })

  test('cancelling stops scheduling any further parts', async () => {
    let started = 0
    const obj = objectOf(100_000)
    const fetchRange = async (s: number, e: number) => {
      started++
      return obj.slice(s, e)
    }
    const reader = rangedStream(100_000, fetchRange, { partBytes: 1000, concurrency: 4 }).getReader()
    await reader.read()
    await reader.cancel()
    const afterCancel = started
    await tick(20)
    expect(started).toBe(afterCancel)
  })

  test('a short part fails the stream instead of splicing a hole into it', async () => {
    const obj = objectOf(1000)
    const fetchRange = async (s: number, e: number) =>
      s === 200 ? obj.slice(s, e - 10) : obj.slice(s, e)
    const rs = rangedStream(1000, fetchRange, { partBytes: 100, concurrency: 2 })
    await expect(collect(rs)).rejects.toThrow(/short read at \[200,300\)/)
  })

  test('a failure in a part fetched ahead still surfaces, and only when reached', async () => {
    // Read-ahead means a part can reject long before anything awaits it. That
    // must not be lost, and must not escape as an unhandled rejection either —
    // under Bun that would take the whole agent down rather than one hydrate.
    const obj = objectOf(1000)
    let reachedFirst = false
    const fetchRange = async (s: number, e: number) => {
      if (s === 900) throw new Error('part 9 is gone')
      if (s === 0) {
        await tick(15) // ensure part 9 has already rejected by the time we read
        reachedFirst = true
      }
      return obj.slice(s, e)
    }
    const rs = rangedStream(1000, fetchRange, { partBytes: 100, concurrency: 10 })
    await expect(collect(rs)).rejects.toThrow('part 9 is gone')
    expect(reachedFirst).toBe(true) // the earlier parts were served first
  })

  test('an object smaller than one part is a single request', async () => {
    const seen: Array<[number, number]> = []
    const obj = objectOf(42)
    const rs = rangedStream(
      42,
      async (s, e) => {
        seen.push([s, e])
        return obj.slice(s, e)
      },
      { partBytes: 1024, concurrency: 8 },
    )
    expect(await collect(rs)).toEqual(obj)
    expect(seen).toEqual([[0, 42]])
  })

  test('a zero-byte object closes cleanly without fetching', async () => {
    let calls = 0
    const rs = rangedStream(
      0,
      async () => {
        calls++
        return new Uint8Array()
      },
      { partBytes: 100, concurrency: 4 },
    )
    expect((await collect(rs)).length).toBe(0)
    expect(calls).toBe(0)
  })
})
