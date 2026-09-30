// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Network failures are retried until the network is back or the user stops:
 * a flaky connection should never surface as a turn error. Clean-EOF replays
 * that make no progress are still bounded (see the wedge tests).
 *
 * Run: bun test packages/shared-app/src/chat/__tests__/auto-resuming-fetch.unbounded.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { ChatRetryWaker, createAutoResumingFetch, type AutoResumeRetryState } from '../auto-resuming-fetch'

const SILENT_LOGGER = { warn: () => {}, log: () => {} }
const TURN_ID = 'turn_unbounded'
const SESSION_ID = 'session_unbounded'
const POST_URL = 'https://api.example.com/api/projects/p1/chat'
const STREAM_URL = `${POST_URL}/${SESSION_ID}/stream`

function sse(event: any): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

const HEAD = [
  sse({ type: 'data-turn-start', data: { turnId: TURN_ID, chatSessionId: SESSION_ID } }),
  sse({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq: 5 } }),
]
const TAIL = [sse({ type: 'text-delta', id: 't', delta: 'done' }), sse({ type: 'data-turn-complete', data: { turnId: TURN_ID } })]

function dies(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++])
      else c.error(new TypeError('network error'))
    },
  })
}

function body(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(x)
      c.close()
    },
  })
}

const headers = (extra: Record<string, string> = {}) => ({
  'Content-Type': 'text/event-stream',
  'X-Turn-Id': TURN_ID,
  ...extra,
})

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return out
    out += decoder.decode(value, { stream: true })
  }
}

describe('auto-resuming fetch: unbounded network retry', () => {
  test('resume keeps retrying network failures past maxResumeAttempts and recovers', async () => {
    let resumeFailures = 0
    const states: AutoResumeRetryState[] = []
    const fetcher = createAutoResumingFetch((async (url: string, init?: any) => {
      if (init?.method === 'POST') {
        return new Response(dies(HEAD), { status: 200, headers: headers({ 'X-Chat-Session-Id': SESSION_ID }) })
      }
      if (resumeFailures < 20) {
        resumeFailures++
        throw new TypeError('Load failed')
      }
      return new Response(body(TAIL), { status: 200, headers: headers() })
    }) as any, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      maxTransportBackoffMs: 0,
      maxResumeAttempts: 2,
      isOffline: () => false,
      onRetryState: (s) => states.push(s),
    })

    const r = await fetcher(POST_URL, { method: 'POST' })
    const text = await readAll(r.body!)

    expect(text).toContain('data-turn-complete')
    expect(resumeFailures).toBe(20)
    expect(states.filter((s) => s.active)).toHaveLength(21)
    expect(states.at(-1)).toMatchObject({ kind: 'resume', active: false, outcome: 'recovered', attempt: 21 })
  })

  test('an idempotent initial POST (X-Client-Turn-Id) retries until the network is back', async () => {
    let posts = 0
    const states: AutoResumeRetryState[] = []
    const fetcher = createAutoResumingFetch((async () => {
      posts++
      if (posts <= 12) throw new TypeError('Load failed')
      return new Response(body([...HEAD, ...TAIL]), { status: 200, headers: headers({ 'X-Chat-Session-Id': SESSION_ID }) })
    }) as any, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 0,
      maxTransportBackoffMs: 0,
      isOffline: () => false,
      onRetryState: (s) => states.push(s),
    })

    const r = await fetcher(POST_URL, { method: 'POST', headers: { 'X-Client-Turn-Id': 'ct-1' } })
    expect(r.status).toBe(200)
    expect(posts).toBe(13)
    expect(states.at(-1)).toMatchObject({ kind: 'initial_request', active: false, outcome: 'recovered', attempt: 12 })
  })

  test('a POST without a client turn id keeps the single bounded retry', async () => {
    let posts = 0
    const fetcher = createAutoResumingFetch((async () => {
      posts++
      throw new TypeError('Load failed')
    }) as any, { logger: SILENT_LOGGER, initialBackoffMs: 0, isOffline: () => false })

    await expect(fetcher(POST_URL, { method: 'POST' })).rejects.toThrow('Load failed')
    expect(posts).toBe(2)
  })

  test('the stream re-attach GET is durable: a mid-turn reset resumes from fromSeq', async () => {
    const calls: string[] = []
    const fetcher = createAutoResumingFetch((async (url: string) => {
      calls.push(url)
      if (url === STREAM_URL) return new Response(dies(HEAD), { status: 200, headers: headers() })
      return new Response(body(TAIL), { status: 200, headers: headers() })
    }) as any, { logger: SILENT_LOGGER, initialBackoffMs: 0, maxTransportBackoffMs: 0, isOffline: () => false })

    const r = await fetcher(STREAM_URL, { method: 'GET' })
    const text = await readAll(r.body!)

    expect(text).toContain('data-turn-complete')
    expect(calls).toEqual([STREAM_URL, `${STREAM_URL}?fromSeq=5`])
  })

  test('user Stop (request abort) ends an unlimited retry loop', async () => {
    let resumes = 0
    const controller = new AbortController()
    const fetcher = createAutoResumingFetch((async (_url: string, init?: any) => {
      if (init?.method === 'POST') {
        return new Response(dies(HEAD), { status: 200, headers: headers({ 'X-Chat-Session-Id': SESSION_ID }) })
      }
      resumes++
      if (resumes === 5) controller.abort()
      throw new TypeError('Load failed')
    }) as any, { logger: SILENT_LOGGER, initialBackoffMs: 0, maxTransportBackoffMs: 0, isOffline: () => false })

    const r = await fetcher(POST_URL, { method: 'POST', signal: controller.signal })
    await readAll(r.body!).catch(() => {})
    const settled = resumes
    await new Promise((res) => setTimeout(res, 20))

    expect(settled).toBe(5)
    expect(resumes).toBe(5)
  })

  test('a wake ("Retry now") cuts the backoff wait short', async () => {
    const waker = new ChatRetryWaker()
    let resumes = 0
    const fetcher = createAutoResumingFetch((async (_url: string, init?: any) => {
      if (init?.method === 'POST') {
        return new Response(dies(HEAD), { status: 200, headers: headers({ 'X-Chat-Session-Id': SESSION_ID }) })
      }
      resumes++
      return new Response(body(TAIL), { status: 200, headers: headers() })
    }) as any, {
      logger: SILENT_LOGGER,
      initialBackoffMs: 60_000,
      maxTransportBackoffMs: 60_000,
      isOffline: () => false,
      wake: waker,
      onRetryState: (s) => {
        if (s.active) setTimeout(() => waker.wake(), 5)
      },
    })

    const started = Date.now()
    const r = await fetcher(POST_URL, { method: 'POST' })
    await readAll(r.body!)
    expect(resumes).toBe(1)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('while offline, the wait lasts until the network comes back', async () => {
    const states: AutoResumeRetryState[] = []
    let offline = true
    const g = globalThis as any
    const listeners = new Set<() => void>()
    const origAdd = g.addEventListener
    const origRemove = g.removeEventListener
    g.addEventListener = (type: string, fn: () => void) => { if (type === 'online') listeners.add(fn) }
    g.removeEventListener = (type: string, fn: () => void) => { if (type === 'online') listeners.delete(fn) }
    try {
      const fetcher = createAutoResumingFetch((async (_url: string, init?: any) => {
        if (init?.method === 'POST') {
          return new Response(dies(HEAD), { status: 200, headers: headers({ 'X-Chat-Session-Id': SESSION_ID }) })
        }
        return new Response(body(TAIL), { status: 200, headers: headers() })
      }) as any, {
        logger: SILENT_LOGGER,
        initialBackoffMs: 0,
        maxTransportBackoffMs: 0,
        isOffline: () => offline,
        onRetryState: (s) => {
          states.push(s)
          if (s.active) {
            setTimeout(() => {
              offline = false
              for (const fn of [...listeners]) fn()
            }, 10)
          }
        },
      })

      const r = await fetcher(POST_URL, { method: 'POST' })
      await readAll(r.body!)
      expect(states[0]).toMatchObject({ active: true, offline: true })
      expect(states[0].nextAttemptAt! - states[0].startedAt).toBeGreaterThanOrEqual(50_000)
      expect(states.at(-1)).toMatchObject({ active: false, outcome: 'recovered' })
    } finally {
      g.addEventListener = origAdd
      g.removeEventListener = origRemove
    }
  })
})
