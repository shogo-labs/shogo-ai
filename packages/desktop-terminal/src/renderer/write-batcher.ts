// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * rAF-coalescing write batcher for xterm.js.
 *
 * Problem: `cat /usr/share/dict/words` floods the PTY with ~5 MB in
 * tens of thousands of tiny chunks. Calling `term.write()` per chunk
 * makes xterm.js's renderer redraw and lay out far more often than
 * 60 Hz can absorb, the UI stalls, and on integrated GPUs the page
 * can lock up for seconds.
 *
 * Fix (matches VS Code's approach): coalesce inbound chunks during a
 * single requestAnimationFrame tick into one `term.write()` call. The
 * terminal only redraws once per frame regardless of how many bytes
 * arrived.
 *
 * Design constraints:
 *
 *   1. **Preserve byte order.** Chunks are concatenated in arrival
 *      order, no reordering, no dedup.
 *
 *   2. **Preserve types.** xterm's `term.write` accepts both `string`
 *      and `Uint8Array`. We pass the union through untouched — mixing
 *      a string and a Uint8Array within the same frame produces two
 *      `term.write` calls (not one), because there is no safe
 *      concatenation across encodings.
 *
 *   3. **Bound the per-frame work.** If a single frame's queue is
 *      bigger than `maxBytesPerFrame` (default 256 KiB) we flush the
 *      first chunk(s) up to that bound and re-schedule the remainder
 *      for the next frame. Prevents pathological 50 MB pastes from
 *      blocking a frame entirely.
 *
 *   4. **Test-friendly clock.** Accept an injectable `schedule` /
 *      `cancel` pair so we can drive frames deterministically.
 *      Default is `requestAnimationFrame` when available, otherwise
 *      `setTimeout(_, 16)`.
 *
 *   5. **dispose() is safe and idempotent.** Any pending frame is
 *      cancelled and the queue is dropped. Subsequent `write()` calls
 *      are no-ops.
 */

export type WriteChunk = string | Uint8Array
export type WriteSink = (data: WriteChunk, callback?: () => void) => void

export interface WriteBatcherOptions {
  /** The terminal's write function (typically `term.write.bind(term)`). */
  sink: WriteSink
  /**
   * Maximum bytes (utf-8) to flush per animation frame. When the
   * queue exceeds this, the excess is deferred to the next frame.
   * Default 256 KiB.
   */
  maxBytesPerFrame?: number
  /**
   * Frame scheduler. Defaults to `requestAnimationFrame` when
   * `window` exists, otherwise a 16 ms setTimeout fallback.
   */
  schedule?: (cb: FrameRequestCallback) => number
  /** Counterpart cancel. */
  cancel?: (handle: number) => void
}

/**
 * A queue of chunks plus the scheduled flush handle.
 *
 * Coalescing is intentionally simple: same-type adjacent chunks are
 * concatenated lazily inside `flush()` (we do not pay for concat on
 * the hot path — chunks just go into an array).
 */
export class WriteBatcher {
  private readonly sink: WriteSink
  private readonly maxBytesPerFrame: number
  private readonly schedule: (cb: FrameRequestCallback) => number
  private readonly cancel: (handle: number) => void

  private queue: WriteChunk[] = []
  private queuedBytes = 0
  private frameHandle: number | null = null
  private disposed = false

  /** Test/inspection counter — number of `sink()` calls fired. */
  private _flushCount = 0
  /** Test/inspection counter — number of frames scheduled. */
  private _frameCount = 0

  constructor(opts: WriteBatcherOptions) {
    this.sink = opts.sink
    this.maxBytesPerFrame = Math.max(1024, opts.maxBytesPerFrame ?? 256 * 1024)
    if (opts.schedule && opts.cancel) {
      this.schedule = opts.schedule
      this.cancel = opts.cancel
    } else if (typeof globalThis !== 'undefined' && typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === 'function') {
      this.schedule = (cb) => (globalThis as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame(cb)
      this.cancel = (h) => (globalThis as { cancelAnimationFrame: (h: number) => void }).cancelAnimationFrame(h)
    } else {
      // Node test fallback.
      this.schedule = (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number
      this.cancel = (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
    }
  }

  /** Enqueue a chunk; flush is scheduled lazily for the next frame. */
  write(chunk: WriteChunk): void {
    if (this.disposed) return
    if (chunkSize(chunk) === 0) return
    this.queue.push(chunk)
    this.queuedBytes += chunkSize(chunk)
    this.ensureScheduled()
  }

  /** Force-flush the queue synchronously (e.g. before screenshot/snapshot). */
  flushNow(): void {
    if (this.disposed) return
    if (this.frameHandle !== null) {
      this.cancel(this.frameHandle)
      this.frameHandle = null
    }
    this.flushChunks(Infinity)
  }

  /** Number of bytes still queued, for diagnostics + tests. */
  get pendingBytes(): number { return this.queuedBytes }
  /** Number of chunks still queued. */
  get pendingChunks(): number { return this.queue.length }
  /** Number of sink invocations since construction. */
  get flushCount(): number { return this._flushCount }
  /** Number of frames scheduled since construction. */
  get frameCount(): number { return this._frameCount }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameHandle !== null) {
      this.cancel(this.frameHandle)
      this.frameHandle = null
    }
    this.queue.length = 0
    this.queuedBytes = 0
  }

  // ─── internals ─────────────────────────────────────────────────────

  private ensureScheduled(): void {
    if (this.frameHandle !== null) return
    this._frameCount++
    this.frameHandle = this.schedule(() => {
      this.frameHandle = null
      this.flushChunks(this.maxBytesPerFrame)
      // If there's still work, re-schedule for the next frame so we
      // make progress every tick even on multi-MB bursts.
      if (this.queue.length > 0) this.ensureScheduled()
    })
  }

  /**
   * Flush up to `byteBudget` bytes. Adjacent chunks of the same type
   * (string-string or Uint8Array-Uint8Array) are concatenated so the
   * sink sees one call per run; a type boundary forces a sink call.
   */
  private flushChunks(byteBudget: number): void {
    if (this.queue.length === 0) return
    let budget = byteBudget
    // Pull off as many full chunks as fit, then optionally split the
    // last one to honour the byte budget exactly.
    let cut = 0
    while (cut < this.queue.length && budget > 0) {
      const size = chunkSize(this.queue[cut]!)
      if (size <= budget) {
        budget -= size
        cut++
      } else {
        break
      }
    }
    let toFlush: WriteChunk[]
    if (cut === this.queue.length && budget >= 0) {
      toFlush = this.queue
      this.queue = []
      this.queuedBytes = 0
    } else if (cut === 0) {
      // First chunk alone exceeds the budget. Split it so we make
      // progress, leave the tail in the queue.
      const head = this.queue[0]!
      const splitAt = Math.max(1, byteBudget)
      const [first, rest] = splitChunk(head, splitAt)
      toFlush = [first]
      this.queue[0] = rest
      this.queuedBytes = this.queuedBytes - chunkSize(first)
    } else {
      toFlush = this.queue.splice(0, cut)
      this.queuedBytes = 0
      for (const c of this.queue) this.queuedBytes += chunkSize(c)
    }

    // Concatenate same-type adjacent chunks within `toFlush` so the
    // sink sees the minimum number of calls.
    const coalesced = coalesceChunks(toFlush)
    for (const c of coalesced) {
      this._flushCount++
      this.sink(c)
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function chunkSize(c: WriteChunk): number {
  return typeof c === 'string' ? c.length : c.byteLength
}

function splitChunk(c: WriteChunk, at: number): [WriteChunk, WriteChunk] {
  if (typeof c === 'string') {
    return [c.slice(0, at), c.slice(at)]
  }
  return [c.subarray(0, at), c.subarray(at)]
}

/**
 * Concatenate adjacent same-type chunks. Strings concat via `+`;
 * Uint8Arrays go through a single allocation per run.
 */
export function coalesceChunks(chunks: readonly WriteChunk[]): WriteChunk[] {
  if (chunks.length <= 1) return chunks.slice()
  const out: WriteChunk[] = []
  let runIsString = typeof chunks[0]! === 'string'
  let runStart = 0
  for (let i = 1; i <= chunks.length; i++) {
    const reachedEnd = i === chunks.length
    const sameType = !reachedEnd && (typeof chunks[i]! === 'string') === runIsString
    if (sameType) continue
    if (i - runStart === 1) {
      out.push(chunks[runStart]!)
    } else if (runIsString) {
      let s = ''
      for (let j = runStart; j < i; j++) s += chunks[j] as string
      out.push(s)
    } else {
      let total = 0
      for (let j = runStart; j < i; j++) total += (chunks[j] as Uint8Array).byteLength
      const buf = new Uint8Array(total)
      let off = 0
      for (let j = runStart; j < i; j++) {
        const u = chunks[j] as Uint8Array
        buf.set(u, off)
        off += u.byteLength
      }
      out.push(buf)
    }
    if (!reachedEnd) {
      runStart = i
      runIsString = typeof chunks[i]! === 'string'
    }
  }
  return out
}
