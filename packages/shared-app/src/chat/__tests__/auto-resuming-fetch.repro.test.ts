// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION + FIX for the production incident behind the client logs:
 *
 *   POST /api/projects/<id>/chat → net::ERR_HTTP2_PROTOCOL_ERROR
 *   [AutoResume:xxxxxxxx] durable body errored: network error
 *   [ChatPanel] Stream error: TypeError: network error
 *   → banner: "Connection interrupted. Please tap Retry to continue."
 *
 * The recurring shape in prod is a MID-STREAM transport reset: the chat POST
 * returns 200 with durable-turn headers, the AI SDK starts reading the body,
 * and then the underlying HTTP/2 stream is killed by a proxy/LB/pod-loss. In
 * the browser that surfaces as `reader.read()` REJECTING with
 * `TypeError: network error` (or `BodyStreamBuffer was aborted` on an abort).
 *
 * BEFORE the fix, `auto-resuming-fetch` only reconnected on a *clean* EOF
 * (`read()` resolves `{done:true}` without `data-turn-complete`). A THROWN read
 * bypassed the resume loop and went straight to `controller.error()`, so the
 * turn was NOT auto-resumed and the error propagated to the AI SDK → the
 * dead-end banner.
 *
 * AFTER the fix, a thrown read is treated exactly like a premature EOF: the
 * wrapper reconnects via `/stream?fromSeq=N`, and only propagates an error if
 * every resume attempt is exhausted. These tests lock that behavior in.
 *
 * Run: bun test packages/shared-app/src/chat/__tests__/auto-resuming-fetch.repro.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { createAutoResumingFetch } from '../auto-resuming-fetch'
import { formatErrorMessage } from '../message-helpers'

const SILENT_LOGGER = { warn: () => {}, log: () => {} }

const TURN_ID = 'turn_repro_http2reset'
const SESSION_ID = 'session_repro_xyz'
const POST_URL = 'https://api.example.com/api/projects/p1/chat'

function sseFrame(event: any): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

function makePostResponse(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Turn-Id': TURN_ID,
      'X-Chat-Session-Id': SESSION_ID,
      ...headers,
    },
  })
}

/**
 * A body that yields `chunks` and then makes the NEXT `reader.read()` REJECT
 * with `error` — the client-side signature of an HTTP/2 stream reset
 * (`net::ERR_HTTP2_PROTOCOL_ERROR` → `TypeError: network error`) or an aborted
 * body buffer (`BodyStreamBuffer was aborted`). This is distinct from a clean
 * EOF, which is `controller.close()`.
 */
function streamThatThrowsAfter(chunks: Uint8Array[], error: Error): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
        return
      }
      throw error
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

describe('mid-stream HTTP/2 reset is auto-resumed (regression: was fatal)', () => {
  test('a mid-stream "network error" reconnects via /stream?fromSeq=N and recovers the turn', async () => {
    // Initial POST body: valid turn-start + a seq heartbeat (so we HAVE a
    // resumable fromSeq=42), then the transport dies mid-stream.
    const initialBody = streamThatThrowsAfter(
      [
        sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
        sseFrame({ type: 'text-delta', delta: 'partial answer so far' }),
        sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 42 } }),
      ],
      new TypeError('network error'), // exactly what Chrome throws on ERR_HTTP2_PROTOCOL_ERROR
    )

    // If the wrapper DID resume, this buffered continuation would complete the
    // turn. The repro proves it never gets fetched.
    const resumeBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(sseFrame({ type: 'text-delta', delta: 'the rest of the answer' }))
        controller.enqueue(
          sseFrame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 43 } }),
        )
        controller.close()
      },
    })

    const calls: Array<{ url: string; method: string }> = []
    const baseFetch: any = async (url: string, init?: any) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST') return makePostResponse(initialBody)
      return new Response(resumeBody, { status: 200, headers: { 'X-Turn-Id': TURN_ID } })
    }

    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
    })

    const r = await fetcher(POST_URL, { method: 'POST' })

    // The durable body no longer rejects — the wrapper silently reattached.
    let caught: unknown = null
    let text = ''
    try {
      text = await readAll(r.body!)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeNull()

    // A resume GET was attempted, from the last seq we saw before the reset.
    const resumeGets = calls.filter((c) => c.method === 'GET')
    expect(resumeGets).toHaveLength(1)
    expect(resumeGets[0].url).toBe(`${POST_URL}/${SESSION_ID}/stream?fromSeq=42`)

    // The buffered continuation reached the consumer and the turn completed.
    expect(text).toContain('partial answer so far')
    expect(text).toContain('the rest of the answer')
    expect(text).toContain('data-turn-complete')
  })

  test('the propagated error maps to the exact user-facing banner', () => {
    // Closes the loop from transport error → ChatPanel banner text.
    expect(formatErrorMessage('network error')).toBe('Connection interrupted. Please tap Retry to continue.')
    // The abort variant seen in the first (interrupted) turn of the same log.
    expect(formatErrorMessage('BodyStreamBuffer was aborted')).toBe(
      'Connection interrupted. Please tap Retry to continue.',
    )
  })

  test('an abort mid-stream ("BodyStreamBuffer was aborted") tries to resume, then surfaces the error if the buffer is gone', async () => {
    const initialBody = streamThatThrowsAfter(
      [
        sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
        sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 7 } }),
      ],
      new DOMException('BodyStreamBuffer was aborted', 'AbortError'),
    )
    const calls: string[] = []
    const baseFetch: any = async (_url: string, init?: any) => {
      const method = init?.method ?? 'GET'
      calls.push(method)
      if (method === 'POST') return makePostResponse(initialBody)
      // Turn buffer no longer exists server-side → 204 is terminal.
      return new Response(null, { status: 204 })
    }
    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    let caught: unknown = null
    try {
      await readAll(r.body!)
    } catch (err) {
      caught = err
    }
    // It DID attempt a resume (the fix) ...
    expect(calls.filter((m) => m === 'GET')).toHaveLength(1)
    // ... but a 204 means the buffer is gone, so the pending abort error is
    // surfaced to the consumer (banner + stuck-tool cleanup) rather than
    // silently truncating.
    expect(caught).not.toBeNull()
  })
})
