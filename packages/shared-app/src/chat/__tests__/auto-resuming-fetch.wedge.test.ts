// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REGRESSION: "messages never finish" — the composer stays wedged in
 * streaming mode (Stop + Queue) even though the assistant reply is fully
 * rendered, so every follow-up gets queued until the user force-sends/stops.
 *
 * Root cause: a turn that completed server-side WITHOUT a `data-turn-complete`
 * frame in its durable buffer (abnormal termination: pod OOM/crash, bg-reader
 * transport error, abort race). Each `/stream?fromSeq=N` reconnect replays the
 * same completed tail (bytes > 0) but never advances the seq cursor and never
 * carries the terminal marker. The old wrapper reset its resume budget on ANY
 * bytes, so it reconnected forever — `useChat().status` pinned at `streaming`,
 * and the stall watchdog never tripped (each replay's `onChunk` reset its
 * liveness timer).
 *
 * Fix (#3): only reset the resume budget when the durable seq cursor advances.
 * Pure-duplicate replays now accrue toward `maxResumeAttempts`, so the wrapper
 * gives up and CLOSES the body (→ AI SDK flips to `ready`, composer unwedges).
 *
 * Run: bun test packages/shared-app/src/chat/__tests__/auto-resuming-fetch.wedge.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { createAutoResumingFetch } from '../auto-resuming-fetch'

const SILENT = { warn: () => {}, log: () => {} }
const TURN_ID = 'turn_wedge'
const SESSION_ID = 'sess_wedge'
const POST_URL = 'https://api.example.com/api/projects/p1/chat'

function sse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

/** A fresh stream that yields `chunks` then cleanly EOFs (like a completed replay). */
function replay(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[i++])
    },
  })
}

async function drainWithCap(body: ReadableStream<Uint8Array>, maxChunks: number) {
  const reader = body.getReader()
  let chunks = 0
  let closed = false
  try {
    while (chunks < maxChunks) {
      const { done, value } = await reader.read()
      if (done) { closed = true; break }
      if (value) chunks++
    }
  } finally {
    try { await reader.cancel() } catch { /* noop */ }
  }
  return { closed, chunks }
}

describe('WEDGE: completed turn whose buffer lacks a data-turn-complete frame', () => {
  test('a replay that never advances seq gives up after maxResumeAttempts and CLOSES (no infinite loop)', async () => {
    // Frames a completed buffer would replay on every reconnect: content, but
    // NO data-turn-seq (so fromSeq never advances) and NO data-turn-complete.
    const tail = () => [
      sse({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID } }),
      sse({ type: 'text-delta', delta: 'Here is the complete answer.' }),
    ]

    const calls: Array<{ method: string; url: string }> = []
    const RUNAWAY_CAP = 100
    const baseFetch: any = async (url: string, init?: any) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      if (method === 'POST') {
        return new Response(replay(tail()), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'X-Turn-Id': TURN_ID,
            'X-Chat-Session-Id': SESSION_ID,
          },
        })
      }
      // Safety valve: if the wrapper regresses to a runaway loop, terminate the
      // test with a 204 instead of hanging CI forever.
      if (calls.filter((c) => c.method === 'GET').length >= RUNAWAY_CAP) {
        return new Response(null, { status: 204 })
      }
      // Completed buffer replays the same tail again, then EOFs.
      return new Response(replay(tail()), { status: 200, headers: { 'X-Turn-Id': TURN_ID } })
    }

    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      maxResumeAttempts: 8,
    })

    const res = await fetcher(POST_URL, { method: 'POST' })
    const { closed } = await drainWithCap(res.body!, 1000)

    const resumeGets = calls.filter((c) => c.method === 'GET').length
    // The body closes on its own (→ useChat flips streaming→ready).
    expect(closed).toBe(true)
    // And it bailed at the budget instead of looping toward the runaway cap.
    expect(resumeGets).toBe(8)
  })

  test('a resume that DOES advance seq still resets the budget (legit long resume unaffected)', async () => {
    // Initial POST EOFs after seq 3 without turn-complete. Each resume advances
    // the seq cursor and eventually the buffer delivers the terminal frame —
    // this must keep resuming and recover, proving the fix only suppresses
    // *non-advancing* replays.
    let n = 0
    const baseFetch: any = async (_url: string, init?: any) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return new Response(
          replay([
            sse({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID } }),
            sse({ type: 'text-delta', delta: 'part-' }),
            sse({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 3 } }),
          ]),
          { status: 200, headers: { 'X-Turn-Id': TURN_ID, 'X-Chat-Session-Id': SESSION_ID } },
        )
      }
      n++
      if (n < 3) {
        // Advancing resumes: new content + a higher seq, but no terminal yet.
        return new Response(
          replay([
            sse({ type: 'text-delta', delta: `more${n}-` }),
            sse({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 3 + n } }),
          ]),
          { status: 200, headers: { 'X-Turn-Id': TURN_ID } },
        )
      }
      // Final resume carries the terminal marker.
      return new Response(
        replay([
          sse({ type: 'text-delta', delta: 'end' }),
          sse({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 3 + n } }),
        ]),
        { status: 200, headers: { 'X-Turn-Id': TURN_ID } },
      )
    }

    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      maxResumeAttempts: 8,
    })

    const res = await fetcher(POST_URL, { method: 'POST' })
    const { closed } = await drainWithCap(res.body!, 1000)

    // Recovered cleanly across 3 advancing resumes (budget kept resetting).
    expect(closed).toBe(true)
    expect(n).toBe(3)
  })
})
