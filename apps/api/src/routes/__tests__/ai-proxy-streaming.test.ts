// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy — Streaming Resilience Tests
 *
 * Covers the three invariants that fix "Claude connection lost":
 *
 *   1. Transient 5xx / 429 / 529 / TCP reset before bytes flow is retried
 *      with exponential backoff + jitter and `Retry-After[-Ms]` honored.
 *   2. AbortError caused by the caller's signal NEVER retries — client
 *      cancel must propagate immediately (so the UI's Stop button works).
 *   3. Mid-stream / truncated-EOF Anthropic streams inject an explicit
 *      `event: error` SSE frame so downstream SDKs see a typed error
 *      instead of a silent end-of-stream.
 *   4. A clean `message_stop` stream never injects a synthetic error.
 *   5. SSE keepalive comments are emitted when upstream is idle (keeps
 *      intermediate proxies from killing long Opus thinking windows).
 *
 * Run: bun test apps/api/src/routes/__tests__/ai-proxy-streaming.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  fetchAnthropicWithRetry,
  wrapSseForErrorVisibility,
  scanForTerminalEvent,
  parseRetryAfter,
  isRetryableNetworkError,
  type StreamErrorPayload,
} from '../ai-proxy'

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const TE = new TextEncoder()
const TD = new TextDecoder()

/** Build a ReadableStream<Uint8Array> from a sequence of string/events. */
function sseStreamFrom(
  chunks: string[],
  opts: { errorAfter?: number; delayMsBetween?: number } = {},
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.delayMsBetween) {
        await new Promise((r) => setTimeout(r, opts.delayMsBetween))
      }
      if (opts.errorAfter !== undefined && i === opts.errorAfter) {
        controller.error(new TypeError('fetch failed'))
        return
      }
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(TE.encode(chunks[i]!))
      i++
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += TD.decode(value, { stream: true })
  }
  return out
}

/** Patch global fetch with a scriptable sequence of responses. */
function scriptFetch(
  script: Array<Response | Error | (() => Promise<Response> | Response | never)>,
) {
  let call = 0
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fn = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const step = script[call++]
    if (step === undefined) {
      throw new Error(`fetch called more than scripted (${call} calls)`)
    }
    if (step instanceof Error) throw step
    if (typeof step === 'function') return await step()
    return step
  })
  ;(globalThis as any).fetch = fn
  return { fn, calls }
}

// ──────────────────────────────────────────────────────────────────────────────
// parseRetryAfter / isRetryableNetworkError (pure helpers)
// ──────────────────────────────────────────────────────────────────────────────

describe('parseRetryAfter', () => {
  test('parses integer seconds', () => {
    expect(parseRetryAfter('3')).toBe(3000)
  })
  test('caps at 30s', () => {
    expect(parseRetryAfter('600')).toBe(30_000)
  })
  test('parses HTTP-date', () => {
    const future = new Date(Date.now() + 2000).toUTCString()
    const ms = parseRetryAfter(future)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThanOrEqual(0)
    expect(ms!).toBeLessThanOrEqual(30_000)
  })
  test('returns null for garbage', () => {
    expect(parseRetryAfter('not-a-date')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
  })
})

describe('isRetryableNetworkError', () => {
  test('detects undici error codes', () => {
    expect(isRetryableNetworkError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableNetworkError({ code: 'UND_ERR_SOCKET' })).toBe(true)
    expect(isRetryableNetworkError({ cause: { code: 'ETIMEDOUT' } })).toBe(true)
  })
  test('detects "fetch failed" messages', () => {
    expect(isRetryableNetworkError(new TypeError('fetch failed'))).toBe(true)
  })
  test('rejects non-network errors', () => {
    expect(isRetryableNetworkError(new TypeError('bad arg'))).toBe(false)
    expect(isRetryableNetworkError(null)).toBe(false)
  })
})

describe('scanForTerminalEvent (split-frame safe)', () => {
  test('finds message_stop', () => {
    expect(
      scanForTerminalEvent('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    ).toBe(true)
  })
  test('finds error event', () => {
    expect(
      scanForTerminalEvent('data: {"type":"error","error":{"type":"overloaded_error"}}\n\n'),
    ).toBe(true)
  })
  test('ignores text delta that quotes the string', () => {
    expect(
      scanForTerminalEvent(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"type:\\"message_stop\\""}}\n\n',
      ),
    ).toBe(false)
  })
  test('catches message_stop even if split across chunks when buffered', () => {
    // Simulate buffering: previous chunk ended with partial data: line.
    const buffered =
      'data: {"type":"content_block_delta"}\n\ndata: {"type":"mess' +
      'age_stop"}\n\n'
    expect(scanForTerminalEvent(buffered)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// fetchAnthropicWithRetry
// ──────────────────────────────────────────────────────────────────────────────

describe('fetchAnthropicWithRetry', () => {
  const origFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = origFetch
  })

  test('returns immediately on 200', async () => {
    const { fn } = scriptFetch([new Response('ok', { status: 200 })])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    })
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('retries on 529 overloaded_error and succeeds on attempt 2', async () => {
    const { fn } = scriptFetch([
      new Response('{"type":"error","error":{"type":"overloaded_error"}}', {
        status: 529,
      }),
      new Response('ok', { status: 200 }),
    ])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('retries on ECONNRESET and succeeds on attempt 2', async () => {
    const err: any = new Error('fetch failed')
    err.code = 'ECONNRESET'
    const { fn } = scriptFetch([err, new Response('ok', { status: 200 })])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('returns final 5xx Response body after maxAttempts', async () => {
    const { fn } = scriptFetch([
      new Response('overloaded 1', { status: 529 }),
      new Response('overloaded 2', { status: 529 }),
    ])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(res.status).toBe(529)
    expect(await res.text()).toBe('overloaded 2')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('does NOT retry on 400 (client error)', async () => {
    const { fn } = scriptFetch([new Response('bad request', { status: 400 })])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(res.status).toBe(400)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('does NOT retry on AbortError and bubbles up', async () => {
    const abortErr = new DOMException('Aborted', 'AbortError')
    const { fn } = scriptFetch([abortErr])
    await expect(
      fetchAnthropicWithRetry(
        'https://x',
        { method: 'POST' },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toThrow(/Aborted/)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('aborts during backoff sleep', async () => {
    const { fn } = scriptFetch([
      new Response('retry me', { status: 503 }),
      new Response('should not reach', { status: 200 }),
    ])
    const ac = new AbortController()
    const promise = fetchAnthropicWithRetry(
      'https://x',
      { method: 'POST' },
      {
        maxAttempts: 3,
        baseDelayMs: 10_000, // long enough that we must abort during sleep
        maxDelayMs: 10_000,
        signal: ac.signal,
      },
    )
    // Give the first fetch a tick to settle into the backoff sleep.
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    await expect(promise).rejects.toThrow(/Aborted/)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('honors Retry-After-Ms header (Anthropic-specific)', async () => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'retry-after-ms': '25',
    })
    const { fn } = scriptFetch([
      new Response('slow down', { status: 429, headers }),
      new Response('ok', { status: 200 }),
    ])
    const t0 = Date.now()
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 10_000, // high base so if we fell back to exp we'd notice
      maxDelayMs: 10_000,
    })
    const elapsed = Date.now() - t0
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(2)
    // We waited ~25ms (retry-after-ms), not ~10s (would have been baseDelay).
    expect(elapsed).toBeLessThan(500)
  })

  test('uses reduced maxAttempts=2 for shogo-cloud label by default', async () => {
    const { fn } = scriptFetch([
      new Response('overloaded 1', { status: 529 }),
      new Response('overloaded 2', { status: 529 }),
    ])
    const res = await fetchAnthropicWithRetry(
      'https://x',
      { method: 'POST' },
      { label: 'shogo-cloud', baseDelayMs: 1, maxDelayMs: 2 }, // no maxAttempts
    )
    expect(res.status).toBe(529)
    expect(fn).toHaveBeenCalledTimes(2) // 2 attempts for cloud hop (not 3)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// wrapSseForErrorVisibility
// ──────────────────────────────────────────────────────────────────────────────

describe('wrapSseForErrorVisibility', () => {
  test('clean message_stop stream is passed through untouched', async () => {
    const clean =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    const wrapped = wrapSseForErrorVisibility(sseStreamFrom([clean]), 'anthropic')
    const out = await collect(wrapped)
    expect(out).toBe(clean)
    expect(out).not.toContain('event: error')
    expect(out).not.toContain('stream_error')
  })

  test('truncated-EOF (no message_stop) injects a typed error frame with code + retryable + meta', async () => {
    const truncated =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'
    const wrapped = wrapSseForErrorVisibility(sseStreamFrom([truncated]), 'anthropic')
    const out = await collect(wrapped)
    expect(out).toStartWith(truncated)
    expect(out).toContain('event: error')

    // Parse the injected error frame
    const errLine = out.split('\n').find((l) => l.startsWith('data: ') && l.includes('stream_error'))!
    const payload: StreamErrorPayload = JSON.parse(errLine.slice(6))
    expect(payload.error.type).toBe('stream_error')
    expect(payload.error.code).toBe('upstream_truncated')
    expect(payload.error.retryable).toBe(true)
    expect(payload.error.meta.chunks).toBe(1)
    expect(payload.error.meta.bytes).toBeGreaterThan(0)
    expect(payload.error.meta.durationMs).toBeGreaterThanOrEqual(0)
    expect(payload.error.message).toContain('message_stop')
  })

  test('mid-stream upstream fault injects a typed error frame with code network_drop', async () => {
    const wrapped = wrapSseForErrorVisibility(
      sseStreamFrom(
        [
          'event: message_start\ndata: {"type":"message_start"}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"half"}}\n\n',
        ],
        { errorAfter: 2 }, // throw after 2 chunks
      ),
      'anthropic',
    )
    const out = await collect(wrapped)
    expect(out).toContain('event: error')

    const errLine = out.split('\n').find((l) => l.startsWith('data: ') && l.includes('stream_error'))!
    const payload: StreamErrorPayload = JSON.parse(errLine.slice(6))
    expect(payload.error.code).toBe('network_drop')
    expect(payload.error.retryable).toBe(true)
    expect(payload.error.meta.chunks).toBe(2)
    expect(payload.error.message).toContain('fetch failed')
  })

  test('does NOT inject error when message_stop is split across chunks', async () => {
    const head =
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'data: {"type":"mess'
    const tail = 'age_stop"}\n\n'
    const wrapped = wrapSseForErrorVisibility(sseStreamFrom([head, tail]), 'anthropic')
    const out = await collect(wrapped)
    expect(out).toBe(head + tail)
    expect(out).not.toContain('event: error\ndata:')
  })

  test('emits a keepalive comment when upstream idles beyond keepaliveMs', async () => {
    // 2 chunks with a 50ms gap; keepalive at 20ms should fire at least once.
    const stream = sseStreamFrom(
      [
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
      { delayMsBetween: 50 },
    )
    const wrapped = wrapSseForErrorVisibility(stream, 'anthropic', {
      keepaliveMs: 20,
    })
    const out = await collect(wrapped)
    expect(out).toContain(': keepalive')
    expect(out).toContain('message_stop')
  })

  test('client-initiated AbortError is propagated cleanly (no synthetic frame)', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException('Aborted', 'AbortError'))
      },
    })
    const wrapped = wrapSseForErrorVisibility(upstream, 'anthropic')
    const out = await collect(wrapped)
    expect(out).not.toContain('event: error')
    expect(out).not.toContain('stream_error')
  })

  test('idle watchdog fires when upstream is silent beyond maxIdleMs', async () => {
    // Upstream sends one chunk then hangs forever.
    let resolveHang: (() => void) | null = null
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (resolveHang) {
          // Second pull — hang until cancelled or test ends.
          await new Promise<void>((r) => { resolveHang = r })
          controller.close()
          return
        }
        controller.enqueue(TE.encode('event: message_start\ndata: {"type":"message_start"}\n\n'))
        resolveHang = () => {}
      },
      cancel() { resolveHang?.() },
    })
    const wrapped = wrapSseForErrorVisibility(upstream, 'anthropic', {
      keepaliveMs: 10,
      maxIdleMs: 50,
      watchdogIntervalMs: 20, // tight interval for testing
    })
    const out = await collect(wrapped)
    expect(out).toContain('event: error')
    const errLine = out.split('\n').find((l) => l.startsWith('data: ') && l.includes('stream_error'))!
    const payload: StreamErrorPayload = JSON.parse(errLine.slice(6))
    expect(payload.error.code).toBe('idle_timeout')
    expect(payload.error.retryable).toBe(true)
    expect(payload.error.message).toContain('No data from anthropic')
  })
})
