// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { createAutoResumingFetch, defaultBuildResumeUrl } from '../auto-resuming-fetch'

const SILENT_LOGGER = { warn: () => {}, log: () => {} }

const TURN_ID = 'turn_test_abc123'
const SESSION_ID = 'session_test_xyz789'
const POST_URL = 'https://api.example.com/api/projects/p1/chat'

function sseFrame(event: any): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[i++])
    },
  })
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

describe('defaultBuildResumeUrl', () => {
  test('appends /<chatSessionId>/stream to a chat POST url', () => {
    expect(defaultBuildResumeUrl('https://api.example.com/api/projects/p1/chat', 's1'))
      .toBe('https://api.example.com/api/projects/p1/chat/s1/stream')
  })
  test('strips trailing slashes', () => {
    expect(defaultBuildResumeUrl('https://api.example.com/api/projects/p1/chat/', 's1'))
      .toBe('https://api.example.com/api/projects/p1/chat/s1/stream')
  })
  test('encodes session ids with special chars', () => {
    expect(defaultBuildResumeUrl('https://api.example.com/api/projects/p1/chat', 'a/b'))
      .toBe('https://api.example.com/api/projects/p1/chat/a%2Fb/stream')
  })
})

describe('createAutoResumingFetch', () => {
  test('passes through non-POST requests unchanged', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const baseFetch: any = async (url: string, init?: any) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      return new Response('ok', { status: 200 })
    }
    const fetcher = createAutoResumingFetch(baseFetch, { logger: SILENT_LOGGER })
    const r = await fetcher('https://api.example.com/anything', { method: 'GET' })
    expect(r.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
  })

  test('passes through responses without durable-turn headers', async () => {
    const body = streamFrom([sseFrame({ type: 'text-delta', delta: 'hi' })])
    const baseFetch: any = async () =>
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    const fetcher = createAutoResumingFetch(baseFetch, { logger: SILENT_LOGGER })
    const r = await fetcher(POST_URL, { method: 'POST' })
    expect(r.status).toBe(200)
    const text = await readAll(r.body!)
    expect(text).toContain('text-delta')
  })

  test('forwards a normal turn (start + complete) without reconnecting', async () => {
    const body = streamFrom([
      sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
      sseFrame({ type: 'text-delta', delta: 'hello' }),
      sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 5 } }),
      sseFrame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 6 } }),
      sseFrame({ type: 'finish', finishReason: 'stop' }),
    ])
    let calls = 0
    const baseFetch: any = async () => {
      calls++
      return makePostResponse(body)
    }
    const fetcher = createAutoResumingFetch(baseFetch, { logger: SILENT_LOGGER })
    const r = await fetcher(POST_URL, { method: 'POST' })
    const text = await readAll(r.body!)
    expect(calls).toBe(1)
    expect(text).toContain('hello')
    expect(text).toContain('data-turn-complete')
  })

  test('auto-resumes with ?fromSeq=N when stream ends without data-turn-complete', async () => {
    const initialBody = streamFrom([
      sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
      sseFrame({ type: 'text-delta', delta: 'partial-' }),
      sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 7 } }),
    ])
    const resumeBody = streamFrom([
      sseFrame({ type: 'text-delta', delta: 'continued' }),
      sseFrame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 9 } }),
    ])

    const calls: Array<{ url: string; method: string }> = []
    const baseFetch: any = async (url: string, init?: any) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      if (calls.length === 1) return makePostResponse(initialBody)
      return new Response(resumeBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'X-Turn-Id': TURN_ID },
      })
    }

    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    const text = await readAll(r.body!)

    expect(calls).toHaveLength(2)
    expect(calls[0].method).toBe('POST')
    expect(calls[1].method).toBe('GET')
    expect(calls[1].url).toBe(`${POST_URL}/${SESSION_ID}/stream?fromSeq=7`)
    expect(text).toContain('partial-')
    expect(text).toContain('continued')
    expect(text).toContain('data-turn-complete')
  })

  test('falls back to fromSeq=0 if no seq heartbeats arrived before EOF', async () => {
    const initialBody = streamFrom([
      sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
    ])
    const resumeBody = streamFrom([
      sseFrame({ type: 'text-delta', delta: 'recovered' }),
      sseFrame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 1 } }),
    ])
    const calls: string[] = []
    const baseFetch: any = async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (calls.length === 1) return makePostResponse(initialBody)
      return new Response(resumeBody, { status: 200, headers: { 'X-Turn-Id': TURN_ID } })
    }
    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    const text = await readAll(r.body!)
    expect(calls[1]).toBe(`GET ${POST_URL}/${SESSION_ID}/stream?fromSeq=0`)
    expect(text).toContain('recovered')
  })

  test('stops resuming when server returns 204 (turn no longer buffered)', async () => {
    const initialBody = streamFrom([
      sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
      sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 3 } }),
    ])
    let calls = 0
    const baseFetch: any = async () => {
      calls++
      if (calls === 1) return makePostResponse(initialBody)
      return new Response(null, { status: 204 })
    }
    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    await readAll(r.body!)
    expect(calls).toBe(2)
  })

  test('stops resuming when server returns a different turnId on resume', async () => {
    const initialBody = streamFrom([
      sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
      sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 2 } }),
    ])
    const resumeBody = streamFrom([
      sseFrame({ type: 'text-delta', delta: 'wrong turn' }),
    ])
    let calls = 0
    const baseFetch: any = async () => {
      calls++
      if (calls === 1) return makePostResponse(initialBody)
      return new Response(resumeBody, {
        status: 200,
        headers: { 'X-Turn-Id': 'turn_DIFFERENT' },
      })
    }
    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    const text = await readAll(r.body!)
    expect(calls).toBe(2)
    // We should not have piped the wrong-turn body into the AI SDK stream.
    expect(text).not.toContain('wrong turn')
  })

  test('onChunk fires for every chunk read off the initial body, including SSE comments', async () => {
    // Mix of regular SSE `data:` frames and a `:`-prefixed keepalive
    // comment (what apps/api emits as `: proxy-keep-alive\n\n`). The
    // wrapper's parser ignores comments for `data-turn-*` book-keeping,
    // but the chunk MUST still bump the liveness callback.
    const keepalive = new TextEncoder().encode(': proxy-keep-alive\n\n')
    const body = streamFrom([
      keepalive,
      sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
      keepalive,
      sseFrame({ type: 'text-delta', delta: 'hi' }),
      sseFrame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 2 } }),
    ])
    const baseFetch: any = async () => makePostResponse(body)

    const chunkEvents: Array<{ bytes: number; resumed: boolean }> = []
    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      onChunk: (info) => chunkEvents.push(info),
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    await readAll(r.body!)

    expect(chunkEvents).toHaveLength(5)
    // All from the initial POST → resumed=false for every event.
    expect(chunkEvents.every((e) => e.resumed === false)).toBe(true)
    // Byte counts match the original encoded chunks.
    expect(chunkEvents[0].bytes).toBe(keepalive.byteLength)
    expect(chunkEvents.reduce((sum, e) => sum + e.bytes, 0)).toBeGreaterThan(0)
  })

  test('onChunk tags chunks delivered via a resumed GET with resumed=true', async () => {
    const initialBody = streamFrom([
      sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
      sseFrame({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 4 } }),
    ])
    const resumeBody = streamFrom([
      sseFrame({ type: 'text-delta', delta: 'after-resume' }),
      sseFrame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 5 } }),
    ])
    let n = 0
    const baseFetch: any = async () => {
      n++
      if (n === 1) return makePostResponse(initialBody)
      return new Response(resumeBody, { status: 200, headers: { 'X-Turn-Id': TURN_ID } })
    }
    const chunkEvents: Array<{ bytes: number; resumed: boolean }> = []
    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      onChunk: (info) => chunkEvents.push(info),
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    await readAll(r.body!)

    const initialChunks = chunkEvents.filter((e) => !e.resumed)
    const resumedChunks = chunkEvents.filter((e) => e.resumed)
    expect(initialChunks.length).toBeGreaterThanOrEqual(2)
    expect(resumedChunks.length).toBeGreaterThanOrEqual(2)
  })

  test('a throwing onChunk does not break the body pipeline', async () => {
    const body = streamFrom([
      sseFrame({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID, startedAt: 1 } }),
      sseFrame({ type: 'text-delta', delta: 'still arrives' }),
      sseFrame({ type: 'data-turn-complete', data: { turnId: TURN_ID, status: 'completed', lastSeq: 1 } }),
    ])
    const baseFetch: any = async () => makePostResponse(body)
    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      onChunk: () => {
        throw new Error('intentional')
      },
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    const text = await readAll(r.body!)
    expect(text).toContain('still arrives')
    expect(text).toContain('data-turn-complete')
  })

  test('respects maxResumeAttempts', async () => {
    let calls = 0
    const baseFetch: any = async () => {
      calls++
      const empty = streamFrom([])
      if (calls === 1) return makePostResponse(empty)
      // Every resume returns an empty body without turn-complete, forcing another retry.
      return new Response(streamFrom([]), { status: 200, headers: { 'X-Turn-Id': TURN_ID } })
    }
    const fetcher = createAutoResumingFetch(baseFetch, {
      logger: SILENT_LOGGER,
      maxResumeAttempts: 2,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    })
    const r = await fetcher(POST_URL, { method: 'POST' })
    await readAll(r.body!)
    // 1 initial + a single successful resume that resets the budget +
    // (since each empty resume body resets attempts on success, we cap on the
    // attempt counter pre-reset). With maxResumeAttempts=2 and resets on
    // successful body open, we expect 1 + 2 = 3 calls before bailing.
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(calls).toBeLessThanOrEqual(4)
  })
})
