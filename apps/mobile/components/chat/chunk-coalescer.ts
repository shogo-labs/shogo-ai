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
 * How long the reader may keep the main thread before it waits a macrotask.
 * Half a frame budget's worth of slack: a commit that follows a slice still
 * lands inside the 200 ms a joined turn is allowed to block for (SHO-306), and
 * a burst that finishes sooner than this pays for no yield at all.
 */
const DEFAULT_SLICE_MS = 50

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now())
const nextMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Coalesce the chunks of `stream` that arrive back to back: a batch is
 * delivered once no chunk has arrived for `idleMs`, or `maxWaitMs` after it
 * started so a long burst still shows progress.
 *
 * Delivery is paced. Handing the SDK a whole batch at once lets it apply every
 * chunk in one unbroken microtask run: each chunk copies the growing message,
 * and every ~50ms of that work (the SDK's update throttle) wakes React's store
 * subscription, so React commits again with more updates already queued behind
 * it. React counts consecutive commits that leave work pending and throws
 * "Maximum update depth exceeded" at 50 — which the panel treats as a stream
 * error, remounts, and replays into again. A fast machine finishes the run
 * before that; a phone (or a CI runner) does not.
 *
 * So the reader hands over chunks only until `sliceMs` of **wall clock** has
 * passed, then waits a macrotask. Wall clock, not the consumer's own apply
 * time: the apply schedules a React commit that runs in its own task, and
 * measuring only the gap between two reads left that commit uncounted, so the
 * next slice started the instant it finished and the main thread ran
 * apply → commit → apply → commit back to back with no idle time for a scroll,
 * a click or a keystroke. That is what a window joining a long turn did while
 * it caught up (SHO-306). Pacing on wall clock bounds the longest unbroken run
 * to the slice plus one commit, and still yields before React's commit-depth
 * counter can trip. Idle time is not counted, so a live stream that arrives
 * slowly pays for nothing.
 */
export function coalesceChunkBursts<T extends UIMessageChunk>(
  stream: ReadableStream<T>,
  {
    idleMs = DEFAULT_IDLE_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    sliceMs = DEFAULT_SLICE_MS,
    yieldToEventLoop = nextMacrotask,
  }: {
    idleMs?: number
    maxWaitMs?: number
    sliceMs?: number
    yieldToEventLoop?: () => Promise<void>
  } = {},
): ReadableStream<T> {
  const reader = stream.getReader()
  let pending: T[] = []
  let ready: T[] = []
  let readyHead = 0
  let sourceDone = false
  let sourceFailed = false
  let sourceError: unknown
  let cancelled = false
  let wake: (() => void) | null = null
  let batchStartedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastYieldAt = now()
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const notify = () => {
    const w = wake
    wake = null
    w?.()
  }
  const drain = () => {
    clearTimer()
    const batch = pending
    pending = []
    if (batch.length === 0) return
    const merged = coalesceChunks(batch)
    ready = readyHead === 0 ? ready : ready.slice(readyHead)
    readyHead = 0
    for (const chunk of merged) ready.push(chunk)
    notify()
  }
  const schedule = () => {
    const at = Date.now()
    if (pending.length === 1) batchStartedAt = at
    clearTimer()
    const wait = Math.max(0, Math.min(idleMs, batchStartedAt + maxWaitMs - at))
    timer = setTimeout(() => {
      timer = null
      drain()
    }, wait)
  }

  // A plain ReadableStream rather than pipeThrough: React Native and the
  // test runtime polyfill streams, and their TransformStream doesn't always
  // pair with the source's ReadableStream implementation.
  return new ReadableStream<T>(
    {
      start() {
        void (async () => {
          try {
            while (!cancelled) {
              const { done, value } = await reader.read()
              if (done) break
              pending.push(value)
              schedule()
            }
            drain()
            sourceDone = true
          } catch (err) {
            drain()
            sourceFailed = true
            sourceError = err
          }
          notify()
        })()
      },
      async pull(controller) {
        while (readyHead >= ready.length) {
          if (sourceFailed) return controller.error(sourceError)
          if (sourceDone) return controller.close()
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          if (cancelled) return
          // Nothing was queued while we waited, so the time just spent was the
          // stream being quiet — not work this reader made the page do.
          lastYieldAt = now()
        }
        if (now() - lastYieldAt >= sliceMs) {
          lastYieldAt = now()
          await yieldToEventLoop()
          if (cancelled) return
        }
        controller.enqueue(ready[readyHead++]!)
      },
      cancel(reason) {
        cancelled = true
        clearTimer()
        pending = []
        ready = []
        readyHead = 0
        notify()
        return reader.cancel(reason)
      },
    },
    // No read-ahead: `pull` runs only when the consumer asks, which is what
    // makes the time between pulls a measure of its processing time.
    { highWaterMark: 0 },
  )
}
