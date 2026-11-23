// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-529 acceptance — the early SSE response head reaches the client at the
 * grace window, and a provider that never answers is ended by the proxy itself.
 *
 * The unit tests in `routes/__tests__/ai-proxy-streaming.test.ts` prove the
 * first chunk is enqueued inside `start()`. They cannot prove Bun puts the
 * response head on the wire with it, which is the actual production bug: the
 * deferred stream's only writer was the keepalive `setInterval`, so the "early"
 * 200 flushed one keepalive late (25.3s measured, 10s grace + 15s tick) and a
 * silent provider left the stream to whatever hop reset it first (300s of
 * plain-text `request timeout` on staging, a bare ECONNRESET at 465.7s through
 * the desktop), with no typed frame for the agent to act on.
 *
 * So this spec runs the real `proxySseWithEarlyHeaders` behind a real
 * `Bun.serve` and measures from the client side, with the same windows scaled
 * down to hundreds of milliseconds.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  proxySseWithEarlyHeaders,
  __setEarlySseTimingForTests,
  type EarlySseOptions,
} from '../routes/ai-proxy'

const GRACE = 300
const KEEPALIVE = 1200
/** Slower than the first keepalive tick, so only an immediate flush is early. */
const PROVIDER_ANSWERS_AT = 3_000

let server: ReturnType<typeof Bun.serve> | null = null

afterEach(() => {
  __setEarlySseTimingForTests()
  server?.stop(true)
  server = null
})

type Started = { headersAt: number; firstByteAt: number | null; endAt: number; body: string }

/** Serve one proxied stream and measure it the way a client does. */
async function measure(
  startUpstream: (signal: AbortSignal) => Promise<Response>,
  options: EarlySseOptions,
): Promise<Started> {
  server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch: () => proxySseWithEarlyHeaders(startUpstream, options),
  })

  const t0 = Date.now()
  const res = await fetch(`http://localhost:${server.port}/`)
  const headersAt = Date.now() - t0
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let firstByteAt: number | null = null
  let body = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstByteAt === null) firstByteAt = Date.now() - t0
    body += decoder.decode(value)
  }

  return { headersAt, firstByteAt, endAt: Date.now() - t0, body }
}

function answersAfter(delayMs: number, chunks: string[] = []): (signal: AbortSignal) => Promise<Response> {
  return () =>
    new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ))
      }, delayMs)
    })
}

const OPENAI_OK = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'

describe('early SSE over a real socket (SHO-529)', () => {
  test('the head and the first keepalive reach the client at the grace window, not one keepalive later', async () => {
    __setEarlySseTimingForTests({ graceMs: GRACE, keepaliveMs: KEEPALIVE, maxWaitMs: 60_000 })

    // The provider is slower than the first keepalive tick, so a stream whose
    // only writer is the interval puts nothing on the wire until grace +
    // keepalive — the shape of the 25.3s production measurement.
    const result = await measure(answersAfter(PROVIDER_ANSWERS_AT, [OPENAI_OK]), {
      providerLabel: 'qa-sho529',
      dialect: 'openai',
    })

    // The head cannot arrive before the grace window (that would be a fast
    // provider answering directly)…
    expect(result.headersAt).toBeGreaterThanOrEqual(GRACE * 0.5)
    // …and it must arrive with a body chunk, well before the first tick.
    expect(result.headersAt).toBeLessThan(GRACE + KEEPALIVE * 0.6)
    expect(result.firstByteAt).toBeLessThan(GRACE + KEEPALIVE * 0.6)
    expect(result.firstByteAt! - result.headersAt).toBeLessThan(700)
    expect(result.body.startsWith(': keepalive')).toBe(true)
    expect(result.body).toContain('OK')
  })

  test('a provider that never answers ends at maxWait with one typed frame and an aborted fetch', async () => {
    const MAX_WAIT = 900
    __setEarlySseTimingForTests({ graceMs: 200, keepaliveMs: 400, maxWaitMs: MAX_WAIT })

    let aborted = false
    const neverAnswers = (signal: AbortSignal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
        })
      })

    const result = await measure(neverAnswers, { providerLabel: 'qa-sho529', dialect: 'openai' })

    // Ended by the proxy at its own cap, i.e. before any hop could reset the
    // socket — and as a clean EOF carrying a frame, not a dropped connection.
    expect(result.endAt).toBeGreaterThanOrEqual(MAX_WAIT * 0.8)
    expect(result.endAt).toBeLessThan(MAX_WAIT + 3_000)
    expect(result.body.split('\n\n').filter((block) => block.includes('"stream_error"'))).toHaveLength(1)
    expect(result.body).toContain('[shogo:retryable=true;code=upstream_timeout]')
    expect(result.body).toContain('Split large tool calls (e.g. write_file then append).')
    expect(result.body).not.toContain('upstream_truncated')
    expect(aborted).toBe(true)
  })

  test('a provider that answers just before the cap keeps streaming past it, uncut', async () => {
    const MAX_WAIT = 600
    __setEarlySseTimingForTests({ graceMs: 100, keepaliveMs: 200, maxWaitMs: MAX_WAIT })

    // Headers at 400ms (inside the cap), then a body that runs until ~1600ms —
    // far past MAX_WAIT, which must not touch a stream that already started.
    const slowBody = () => new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder()
              for (const text of ['FIRST', 'SECOND', 'THIRD']) {
                await new Promise((r) => setTimeout(r, 400))
                controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`))
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ))
      }, 400)
    })

    const result = await measure(slowBody, { providerLabel: 'qa-sho529', dialect: 'openai' })

    expect(result.endAt).toBeGreaterThan(MAX_WAIT)
    expect(result.body).toContain('FIRST')
    expect(result.body).toContain('THIRD')
    expect(result.body).not.toContain('upstream_timeout')
  })
})
