// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { UIMessageChunk } from "ai"

/**
 * A resumed turn replays the runtime's buffer from seq 0: tens of thousands
 * of one-token deltas arriving at once. The AI SDK applies every chunk as a
 * separate message update (copying the message's parts each time), so the
 * replay alone can pin a slow phone's main thread for minutes. Merging the
 * chunks that arrive together into one delta per part gives the SDK the same
 * message for a fraction of the work, and the panel re-renders once per
 * batch instead of once per network read. A live stream, where chunks arrive
 * apart, passes through after `idleMs` of quiet.
 */

type Chunk = UIMessageChunk & Record<string, any>

const DEFAULT_IDLE_MS = 16
const DEFAULT_MAX_WAIT_MS = 250

function mergeDeltas(a: Chunk, b: Chunk): Chunk | null {
  if (a.type !== b.type || a.providerMetadata || b.providerMetadata) return null
  if ((a.type === "text-delta" || a.type === "reasoning-delta") && a.id === b.id) {
    return { ...a, delta: a.delta + b.delta }
  }
  if (a.type === "tool-input-delta" && a.toolCallId === b.toolCallId) {
    return { ...a, inputTextDelta: a.inputTextDelta + b.inputTextDelta }
  }
  return null
}

function isSeqHeartbeat(chunk: Chunk): boolean {
  return chunk.type === "data-turn-seq" && chunk.transient === true
}

/**
 * Merge runs of deltas for the same part. Transient `data-turn-seq`
 * heartbeats only report the latest buffered seq, so all but the last one in
 * the batch are dropped (they would otherwise split every run of deltas).
 */
export function coalesceChunks<T extends UIMessageChunk>(chunks: T[]): T[] {
  let lastHeartbeat = -1
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (isSeqHeartbeat(chunks[i] as Chunk)) {
      lastHeartbeat = i
      break
    }
  }
  const out: Chunk[] = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as Chunk
    if (isSeqHeartbeat(chunk) && i !== lastHeartbeat) continue
    const prev = out[out.length - 1]
    const merged = prev ? mergeDeltas(prev, chunk) : null
    if (merged) out[out.length - 1] = merged
    else out.push(chunk)
  }
  return out as T[]
}

/**
 * Coalesce the chunks of `stream` that arrive back to back: a batch is
 * delivered once no chunk has arrived for `idleMs`, or `maxWaitMs` after it
 * started so a long burst still shows progress.
 */
export function coalesceChunkBursts<T extends UIMessageChunk>(
  stream: ReadableStream<T>,
  { idleMs = DEFAULT_IDLE_MS, maxWaitMs = DEFAULT_MAX_WAIT_MS } = {},
): ReadableStream<T> {
  const reader = stream.getReader()
  let pending: T[] = []
  let batchStartedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  // A plain ReadableStream rather than pipeThrough: React Native and the
  // test runtime polyfill streams, and their TransformStream doesn't always
  // pair with the source's ReadableStream implementation.
  return new ReadableStream<T>({
    start(controller) {
      const drain = () => {
        clearTimer()
        const batch = pending
        pending = []
        for (const chunk of coalesceChunks(batch)) controller.enqueue(chunk)
      }
      const schedule = () => {
        const now = Date.now()
        if (pending.length === 1) batchStartedAt = now
        clearTimer()
        const wait = Math.max(0, Math.min(idleMs, batchStartedAt + maxWaitMs - now))
        timer = setTimeout(() => {
          timer = null
          try {
            drain()
          } catch {
            // The consumer cancelled the stream; nothing left to deliver.
          }
        }, wait)
      }
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            pending.push(value)
            schedule()
          }
          drain()
          controller.close()
        } catch (err) {
          try {
            drain()
            controller.error(err)
          } catch {
            // Already cancelled.
          }
        }
      })()
    },
    cancel(reason) {
      clearTimer()
      pending = []
      return reader.cancel(reason)
    },
  })
}
