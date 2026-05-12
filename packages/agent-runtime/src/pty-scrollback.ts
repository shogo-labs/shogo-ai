// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bounded chunk ring keyed by chunk-seq.
 *
 * Stores PTY output chunks oldest-first. When total bytes exceed `capacity`
 * we evict the oldest chunk(s) — we never slice mid-chunk, so replay
 * boundaries always land on chunk borders (and therefore on safe escape-
 * sequence boundaries, since each chunk is what the kernel handed us).
 *
 * `firstRetainedSeq` is the lowest seq still recoverable. A replay request
 * `sinceSeq` is `truncated` when there's a gap between what the caller
 * wants (sinceSeq + 1) and the oldest chunk we still hold.
 *
 * Why not a circular Uint8Array? Output chunks vary wildly in size (one
 * keystroke vs a 64 KB cat). A chunk-list keeps the math simple and
 * avoids byte-by-byte copies on the hot path.
 */

export class ScrollbackRing {
  readonly capacity: number
  /** Oldest-first. Each entry's `seq` is its chunk-seq. */
  private chunks: { seq: number; bytes: Uint8Array }[] = []
  private bytes = 0
  /** Lowest chunk-seq still in the ring (0 when empty). */
  private firstRetainedSeq = 0

  constructor(capacity: number) {
    // Trust the caller — tests pass small capacities to drive eviction. A
    // 0/negative floor would still evict everything; we only guard NaN.
    this.capacity = Number.isFinite(capacity) ? Math.max(0, capacity | 0) : 0
  }

  get size(): number { return this.bytes }
  get oldestSeq(): number { return this.firstRetainedSeq }

  append(seq: number, chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    if (this.chunks.length === 0) this.firstRetainedSeq = seq
    this.chunks.push({ seq, bytes: chunk })
    this.bytes += chunk.byteLength
    while (this.bytes > this.capacity && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.bytes -= dropped.bytes.byteLength
      this.firstRetainedSeq = this.chunks[0].seq
    }
  }

  replaySince(sinceSeq: number): {
    bytes: Uint8Array
    latestSeq: number
    truncated: boolean
  } {
    if (this.chunks.length === 0) {
      return { bytes: new Uint8Array(0), latestSeq: sinceSeq, truncated: false }
    }
    // Truncated means: caller wants chunks starting at sinceSeq+1, but the
    // oldest chunk we still have is later than that. sinceSeq===0 means
    // "give me everything you have" so it's never flagged truncated.
    const want = sinceSeq + 1
    const truncated = sinceSeq !== 0 && want < this.firstRetainedSeq
    // Find the first chunk with seq > sinceSeq.
    let start = 0
    while (start < this.chunks.length && this.chunks[start].seq <= sinceSeq) {
      start++
    }
    const slice = this.chunks.slice(start)
    if (slice.length === 0) {
      return { bytes: new Uint8Array(0), latestSeq: sinceSeq, truncated }
    }
    let total = 0
    for (const c of slice) total += c.bytes.byteLength
    const out = new Uint8Array(total)
    let off = 0
    for (const c of slice) {
      out.set(c.bytes, off)
      off += c.bytes.byteLength
    }
    const latestSeq = slice[slice.length - 1].seq
    return { bytes: out, latestSeq, truncated }
  }
}
