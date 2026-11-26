// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A byte budget for whole-object reads, and the bounded reader that uses it.
 *
 * Guest exports are pulled over the control channel into host memory because
 * every consumer (the lineage guard, the quarantine copy) needs the bytes as a
 * `Uint8Array`. That is fine for the median project and was fatal for the tail:
 * on 2026-11-26 a single workspace-member export kept reading for 60 s until its
 * deadline, and by 15 s in the agent was holding **~33 GiB** of it (SHO-593).
 * The export side has no cap, so "the largest project is 1.8 GB" was a
 * description of that day's data, not a bound.
 *
 * Two brakes, in this order:
 *
 *   1. `ByteBudget` — total bytes of in-flight exports. A read reserves what it
 *      expects to hold (the `content-length`, or the whole budget when the guest
 *      streams chunked and does not say) and releases when it is done, so two
 *      big exports cannot be in memory at once.
 *   2. `capBytes` — a hard ceiling on ONE body. Past it the read is cancelled
 *      instead of finishing: those bytes could not be uploaded within the export
 *      deadline anyway, so today they cost the whole buffer and produce nothing.
 *      Failing fast keeps the previous durable backup, logs the project, and
 *      counts it in `metal_export_too_large_total`.
 */

/** Bytes in flight for one kind of whole-object read. FIFO, with a peak. */
export class ByteBudget {
  private usedBytes = 0
  private waiters: Array<{ bytes: number; grant: () => void }> = []
  peakBytes = 0
  waitedMs = 0

  constructor(
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  get inUse(): number {
    return this.usedBytes
  }

  /** Reserve `bytes` (clamped to the whole budget) and wait until they fit. */
  async acquire(bytes: number): Promise<void> {
    const want = Math.max(1, Math.min(bytes, this.maxBytes))
    if (this.usedBytes === 0 && this.waiters.length === 0) {
      this.usedBytes = want
      this.peakBytes = Math.max(this.peakBytes, this.usedBytes)
      return
    }
    const started = this.now()
    await new Promise<void>((resolve) => {
      this.waiters.push({ bytes: want, grant: resolve })
      this.drain()
    })
    this.waitedMs += this.now() - started
  }

  release(bytes: number): void {
    const held = Math.max(1, Math.min(bytes, this.maxBytes))
    this.usedBytes = Math.max(0, this.usedBytes - held)
    this.drain()
  }

  private drain(): void {
    while (this.waiters.length) {
      const next = this.waiters[0]!
      if (this.usedBytes + next.bytes > this.maxBytes) return
      this.waiters.shift()
      this.usedBytes += next.bytes
      this.peakBytes = Math.max(this.peakBytes, this.usedBytes)
      next.grant()
    }
  }
}

/** A single archive over {@link ReadBoundedOptions.capBytes}: refused, not buffered. */
export class BodyTooLargeError extends Error {
  readonly code = 'body-too-large'
  constructor(
    readonly label: string,
    readonly bytes: number,
    readonly capBytes: number,
  ) {
    super(`${label} is ${bytes} bytes, over the ${capBytes}-byte in-memory export cap`)
    this.name = 'BodyTooLargeError'
  }
}

export interface ReadBoundedOptions {
  /** Shared budget; omit to skip the reservation (tests, tiny bodies). */
  budget?: ByteBudget
  /** Hard ceiling for one body. `0` disables the cap. */
  capBytes: number
  /** Names the read in the error and the log ("workspace member …"). */
  label: string
}

/**
 * Read a response body into memory within the budget and under the cap.
 *
 * With a `content-length` the destination is allocated once and filled, so the
 * body costs one copy. Without one — which is what the guest sends — chunks are
 * kept until the stream ends, which costs at most two: the chunks and the join.
 * That factor is why the default cap is a fraction of the RSS target.
 */
export async function readBoundedBody(res: Response, opts: ReadBoundedOptions): Promise<Uint8Array> {
  const { budget, capBytes, label } = opts
  const declared = Number(res.headers.get('content-length')) || 0
  if (capBytes > 0 && declared > capBytes) {
    await res.body?.cancel().catch(() => {})
    throw new BodyTooLargeError(label, declared, capBytes)
  }

  const reserve = budget ? Math.min(declared || capBytes || 1, capBytes || declared || 1) : 0
  if (budget && reserve > 0) await budget.acquire(reserve)
  try {
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer())
      if (capBytes > 0 && buf.byteLength > capBytes) throw new BodyTooLargeError(label, buf.byteLength, capBytes)
      return buf
    }

    const reader = res.body.getReader()
    if (declared > 0) {
      const out = new Uint8Array(declared)
      let off = 0
      let grown: Uint8Array[] | null = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        off += value.byteLength
        if (capBytes > 0 && off > capBytes) {
          await reader.cancel().catch(() => {})
          throw new BodyTooLargeError(label, off, capBytes)
        }
        if (grown) {
          grown.push(value)
        } else if (off <= out.byteLength) {
          out.set(value, off - value.byteLength)
        } else {
          // The guest sent more than it declared: keep what we have, switch to
          // chunks, and let the caller see the real size.
          grown = [out.subarray(0, off - value.byteLength), value]
        }
      }
      if (grown) return joinChunks(grown, off)
      return off === out.byteLength ? out : out.subarray(0, off)
    }

    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      if (capBytes > 0 && total > capBytes) {
        // Stop reading rather than buffer bytes that cannot be used.
        await reader.cancel().catch(() => {})
        throw new BodyTooLargeError(label, total, capBytes)
      }
      chunks.push(value)
    }
    return joinChunks(chunks, total)
  } finally {
    if (budget && reserve > 0) budget.release(reserve)
  }
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}
