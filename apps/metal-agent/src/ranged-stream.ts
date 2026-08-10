// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Parallel ranged GETs, delivered as one ordered byte stream.
 *
 * `downloadRanged` already fetches parts N-wide, but it pwrites them to a file,
 * so the whole object has to land before anything can read it. Hydrate needs the
 * opposite shape: bytes in order, as they arrive, so the guest's `tar` can
 * extract while the rest is still in flight and neither side ever holds the
 * archive.
 *
 * The reason to fetch in parts at all is not aggregate bandwidth — it is that
 * the object store's slow mode is per-CONNECTION. Measured against a 217 MB
 * archive from a production host, one stream ran at 91 MB/s and then 4.0 MB/s
 * minutes later, while eight-wide over the same slow patch still held 49.6 MB/s.
 * A single stream that lands in the slow mode has no recourse; with parts, a bad
 * connection holds back one part rather than the transfer, and the work-stealing
 * loop lets the healthy lanes carry the rest. That difference is the whole
 * reason a cold boot times out: the guest pulls single-stream and measured
 * 1.5-10.6 MB/s, against a 100-second budget.
 *
 * Memory is bounded by `concurrency * partBytes` regardless of object size,
 * because a part is only fetched when a slot frees and slots free only as the
 * consumer reads. A stalled reader stops the fetching too.
 */

import type { RangeFetcher } from './snapshot-store'

/**
 * Stream `size` bytes of an object in order, fetching `partBytes` chunks up to
 * `concurrency`-wide ahead of the read cursor.
 *
 * Storage-agnostic for the same reason `downloadRanged` is: it takes a
 * `RangeFetcher`, so the offset math, ordering, window bound and error
 * propagation are testable without S3.
 */
export function rangedStream(
  size: number,
  fetchRange: RangeFetcher,
  opts: { partBytes: number; concurrency: number },
): ReadableStream<Uint8Array> {
  const partBytes = Math.max(1, Math.floor(opts.partBytes))
  const parts: Array<[number, number]> = []
  for (let start = 0; start < size; start += partBytes) {
    parts.push([start, Math.min(start + partBytes, size)])
  }
  const lanes = Math.max(1, Math.min(Math.floor(opts.concurrency) || 1, parts.length))

  /** Parts fetched but not yet handed to the consumer, keyed by part index. */
  const inflight = new Map<number, Promise<Uint8Array>>()
  let cursor = 0 // next part to emit
  let scheduled = 0 // next part to start fetching
  let stopped = false

  const begin = (i: number): void => {
    const [start, end] = parts[i]
    const p = fetchRange(start, end).then(buf => {
      // A truncated part would splice into the stream unnoticed and produce a
      // corrupt archive that extracts partway — fail loudly instead.
      if (buf.length !== end - start) {
        throw new Error(`ranged GET short read at [${start},${end}): got ${buf.length} bytes`)
      }
      return buf
    })
    // Nothing awaits a part until the cursor reaches it, so a read-ahead
    // failure would otherwise be an unhandled rejection — which in Bun takes
    // the agent down. Park it here; `pull` still sees it when its turn comes.
    p.catch(() => {})
    inflight.set(i, p)
  }

  const fill = (): void => {
    while (!stopped && inflight.size < lanes && scheduled < parts.length) begin(scheduled++)
  }

  return new ReadableStream<Uint8Array>({
    start: fill,

    // `pull` is called only when the consumer wants more, so this is where the
    // backpressure comes from: no new part is scheduled until one is drained.
    async pull(controller) {
      if (cursor >= parts.length) {
        controller.close()
        return
      }
      try {
        const buf = await inflight.get(cursor)!
        inflight.delete(cursor)
        cursor++
        controller.enqueue(buf)
        fill()
      } catch (err) {
        stopped = true
        inflight.clear()
        throw err
      }
    },

    cancel() {
      stopped = true
      inflight.clear()
    },
  })
}
