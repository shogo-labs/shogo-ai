// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION + FIX for the production Sentry issue JAVASCRIPT-REACT-46:
 *
 *   AI_JSONParseError: JSON parsing failed: Text: {"type":"tool-output-available",...
 *   SyntaxError: JSON Parse error: Expected '}'
 *     at safeParseJSON (@ai-sdk/provider-utils)
 *   → tagged shogo_telemetry=chat_stream_error, 298 events since 2026-07-09
 *
 * Root cause: the durable-resume wrapper (`auto-resuming-fetch`) forwarded raw
 * bytes to the AI SDK's SSE parser AS THEY ARRIVED, with no frame alignment.
 * The server's stream buffer (`@shogo/core` StreamBuffer) stores raw byte
 * chunks keyed by a monotonic `seq` and, on `?fromSeq=N`, replays whole chunks
 * with `seq > N`. When a transport reset lands MID-FRAME (a big
 * `tool-output-available` frame split across HTTP/2 DATA frames), the AI SDK
 * parser was already holding a partial `data: {…}` line. The resume then
 * replayed from a chunk/seq boundary that did NOT match the byte offset where
 * the partial was cut, so a truncated `tool-output-available` frame got spliced
 * against a replayed `data-turn-seq` frame:
 *
 *     data: {"type":"tool-output-available",…,"output":{"text":"Minin
 *     data: {"type":"data-turn-seq","data":{…}}
 *
 * i.e. one corrupt line with no `\n\n` between them → `JSON.parse` throws
 * `Expected '}'`.
 *
 * Fix: the durable body now only forwards COMPLETE SSE frames (terminated by
 * the `\n\n` delimiter). A trailing partial frame is buffered and DISCARDED on
 * a mid-turn disconnect — the resume re-sends that frame in full from
 * `fromSeq`, so the AI SDK never sees a spliced/half line.
 *
 * Run: bun test packages/shared-app/src/chat/__tests__/auto-resuming-fetch.frame-splice.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { createAutoResumingFetch } from '../auto-resuming-fetch'

const SILENT_LOGGER = { warn: () => {}, log: () => {} }

const TURN_ID = 'turn_frame_splice'
const SESSION_ID = 'session_frame_splice'
const POST_URL = 'https://api.example.com/api/projects/p1/chat'

const enc = (s: string) => new TextEncoder().encode(s)
function sseFrame(event: unknown): Uint8Array {
  return enc(`data: ${JSON.stringify(event)}\n\n`)
}

function makePostResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Turn-Id': TURN_ID,
      'X-Chat-Session-Id': SESSION_ID,
    },
  })
}

/** A body that yields `chunks` then makes the NEXT read REJECT (HTTP/2 reset). */
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

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
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

/**
 * Parse the byte stream exactly like the AI SDK's SSE reader does: split on the
 * `\n\n` frame delimiter, then `JSON.parse` each `data:` payload. Returns the
 * list of payloads that FAILED to parse — this is precisely the set that would
 * surface as `AI_JSONParseError` in `safeParseJSON`.
 */
function findUnparseableDataFrames(streamText: string): string[] {
  const bad: string[] = []
  for (const frame of streamText.split('\n\n')) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        JSON.parse(payload)
      } catch {
        bad.push(payload)
      }
    }
  }
  return bad
}

describe('mid-frame transport reset must not splice a truncated frame against the replay', () => {
  test('a big tool-output frame cut mid-way is re-delivered whole, never spliced (AI_JSONParseError)', async () => {
    // The huge `tool-output-available` payload the browser-QA agent streams.
    const toolOutput = {
      type: 'tool-output-available',
      toolCallId: 'call_140f189c456943f58e86f10c',
      output: { text: 'Construction, Oil & Gas, Manufacturing, Mining' },
    }
    const toolFrameBytes = sseFrame(toolOutput)
    const toolFrameText = new TextDecoder().decode(toolFrameBytes)
    // The transport delivers only the FIRST HALF of the frame, then the HTTP/2
    // stream resets — the browser surfaces this as `reader.read()` rejecting.
    const half = Math.floor(toolFrameText.length * 0.6)
    const partialToolFrame = enc(toolFrameText.slice(0, half)) // NOTE: no `\n\n`

    const initialBody = streamThatThrowsAfter(
      [
        sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID } }),
        sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 10 } }),
        partialToolFrame,
      ],
      new TypeError('network error'),
    )

    // On resume from fromSeq=10 the buffer replays whole chunks with seq > 10:
    // the seq-11 heartbeat FIRST (this is what got spliced onto the partial in
    // prod), then the FULL tool-output frame, then the terminal marker.
    const resumeBody = streamFrom([
      sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 11 } }),
      toolFrameBytes,
      sseFrame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 12 } }),
    ])

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
    const text = await readAll(r.body!)

    // It resumed from the last fully-received seq heartbeat.
    const resumeGets = calls.filter((c) => c.method === 'GET')
    expect(resumeGets).toHaveLength(1)
    expect(resumeGets[0].url).toBe(`${POST_URL}/${SESSION_ID}/stream?fromSeq=10`)

    // THE REGRESSION ASSERTION: every `data:` frame the AI SDK sees must be
    // valid JSON. Before the fix, the truncated tool-output frame was spliced
    // against the replayed `data-turn-seq` frame → an unparseable payload.
    const bad = findUnparseableDataFrames(text)
    expect(bad).toEqual([])

    // And the turn still recovers: the tool output arrives intact, the turn
    // completes, and the partial fragment is never surfaced as its own frame.
    expect(text).toContain('"toolCallId":"call_140f189c456943f58e86f10c"')
    expect(text).toContain('Mining')
    expect(text).toContain('data-turn-complete')
    // The truncated fragment must not lead a `data:` frame (it was dropped).
    expect(text).not.toMatch(/data: \{"type":"tool-output-available"[^\n]*Minindata:/)
  })

  test('a clean EOF mid-frame (no throw) is also frame-aligned on resume', async () => {
    // Same shape but the initial body cleanly EOFs mid-frame instead of throwing.
    const toolOutput = {
      type: 'tool-output-available',
      toolCallId: 'call_eof',
      output: { text: 'x'.repeat(200) },
    }
    const toolFrameBytes = sseFrame(toolOutput)
    const toolFrameText = new TextDecoder().decode(toolFrameBytes)
    const partial = enc(toolFrameText.slice(0, 40)) // no `\n\n`

    const initialBody = streamFrom([
      sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID } }),
      sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 5 } }),
      partial,
    ])
    const resumeBody = streamFrom([
      toolFrameBytes,
      sseFrame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 6 } }),
    ])
    let n = 0
    const baseFetch: any = async (_url: string, init?: any) => {
      n++
      if ((init?.method ?? 'GET') === 'POST') return makePostResponse(initialBody)
      return new Response(resumeBody, { status: 200, headers: { 'X-Turn-Id': TURN_ID } })
    }
    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    const text = await readAll(r.body!)

    expect(findUnparseableDataFrames(text)).toEqual([])
    expect(text).toContain('"toolCallId":"call_eof"')
    expect(text).toContain('data-turn-complete')
  })
})
