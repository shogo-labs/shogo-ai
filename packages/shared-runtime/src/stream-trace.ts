// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Opt-in timing for a chat response stream (`SHOGO_STREAM_TRACE=1`).
 *
 * A stream passes through several stages (runtime replay, API fan-out,
 * keepalive wrapper). To see which one adds delay without relying on chunk
 * identity (the keepalive wrapper re-slices bytes), each stage records
 * (cumulative bytes, time) as chunks pass. A byte offset's delay between two
 * stages is the gap between the first mark at or past it in each. A timer also
 * tracks event-loop lag, which shows when synchronous work in the process (JSON,
 * persistence) holds up delivery.
 *
 * When the variable is unset every helper is a no-op.
 */

export function streamTraceEnabled(): boolean {
  const v = process.env.SHOGO_STREAM_TRACE
  return v === '1' || v === 'true'
}

interface Mark {
  bytes: number
  at: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

export interface StreamTrace {
  /** Record `bytes` passing the named stage. */
  mark(stage: string, bytes: number): void
  /** Log the summary; call once when the stream ends. */
  end(): void
}

const NOOP: StreamTrace = { mark() {}, end() {} }

const LOOP_INTERVAL_MS = 10

export function createStreamTrace(label: string, stages: string[]): StreamTrace {
  if (!streamTraceEnabled()) return NOOP

  const startedAt = Date.now()
  const marks = new Map<string, Mark[]>(stages.map((s) => [s, []]))
  const totals = new Map<string, number>(stages.map((s) => [s, 0]))
  const loopLags: number[] = []
  let expected = Date.now() + LOOP_INTERVAL_MS
  const timer = setInterval(() => {
    const now = Date.now()
    loopLags.push(Math.max(0, now - expected))
    expected = now + LOOP_INTERVAL_MS
  }, LOOP_INTERVAL_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()

  let ended = false
  return {
    mark(stage, bytes) {
      const list = marks.get(stage)
      if (!list || ended) return
      const total = (totals.get(stage) ?? 0) + bytes
      totals.set(stage, total)
      list.push({ bytes: total, at: Date.now() })
    },
    end() {
      if (ended) return
      ended = true
      clearInterval(timer)

      const summary: Record<string, unknown> = {
        label,
        durationMs: Date.now() - startedAt,
        stages: Object.fromEntries(
          stages.map((s) => {
            const list = marks.get(s)!
            return [s, { chunks: list.length, bytes: totals.get(s) ?? 0, meanChunk: list.length ? Math.round((totals.get(s) ?? 0) / list.length) : 0 }]
          }),
        ),
      }

      // Delay of each stage relative to the first one.
      const first = marks.get(stages[0])!
      const delays: Record<string, { p50: number; p95: number; max: number }> = {}
      for (const s of stages.slice(1)) {
        const later = marks.get(s)!
        const lags: number[] = []
        let cursor = 0
        for (const m of first) {
          while (cursor < later.length && later[cursor].bytes < m.bytes) cursor++
          if (cursor >= later.length) break
          lags.push(Math.max(0, later[cursor].at - m.at))
        }
        lags.sort((a, b) => a - b)
        delays[`${stages[0]}->${s}`] = { p50: percentile(lags, 50), p95: percentile(lags, 95), max: lags.length ? lags[lags.length - 1] : 0 }
      }
      summary.delaysMs = delays

      const sortedLoop = [...loopLags].sort((a, b) => a - b)
      summary.eventLoopLagMs = { p95: percentile(sortedLoop, 95), max: sortedLoop.length ? sortedLoop[sortedLoop.length - 1] : 0, over50: sortedLoop.filter((v) => v > 50).length }

      console.log(`[StreamTrace] ${JSON.stringify(summary)}`)
    },
  }
}

/** Passes a stream through unchanged, recording each chunk against `stage`. */
export function traceStream(
  trace: StreamTrace,
  stage: string,
  stream: ReadableStream<Uint8Array>,
  endsTrace = false,
): ReadableStream<Uint8Array> {
  if (trace === NOOP) return stream
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        trace.mark(stage, chunk.byteLength)
        controller.enqueue(chunk)
      },
      flush() {
        if (endsTrace) trace.end()
      },
    }),
  )
}
